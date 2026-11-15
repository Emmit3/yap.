import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import {
  creatorImageContextSchema,
  creatorImageGenerateSchema,
  creatorImageInputSchema,
  creatorImageJobSchema,
  creatorImageQuoteSchema,
  type CreatorImageContext,
  type CreatorImageGenerate,
  type CreatorImageInput,
  type CreatorImageJob,
  type CreatorImageQuote,
} from '@yap/contracts/reference-assets';
import { ApiError } from './errors.js';
import { readBounded } from './creator-video-provider.js';
import { productionStore, verifyProductionFile } from './creator-production-storage.js';

export const CREATOR_IMAGE_MODEL = 'gpt-image-2-2026-04-21';
export const CREATOR_IMAGE_MAX_CENTS = 10;
export interface CreatorImageResult {
  bytes: Buffer;
  usage?: { inputTokens: number; outputTokens: number };
  requestId?: string;
}
export interface CreatorImageAdapter {
  configured: boolean;
  model: typeof CREATOR_IMAGE_MODEL;
  quote(input: CreatorImageInput): {
    model: typeof CREATOR_IMAGE_MODEL;
    size: '1024x1536';
    quality: 'medium';
    maxCostCents: 10;
  };
  generate(
    quote: CreatorImageQuote,
    signal: AbortSignal,
    beforeSubmit?: () => Promise<void>,
  ): Promise<CreatorImageResult>;
}
export type ApprovedImageOperation = <T>(
  quote: CreatorImageQuote,
  requestId: string,
  operation: () => Promise<T>,
) => Promise<T>;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function checkedInput(value: unknown): CreatorImageInput {
  const input = creatorImageInputSchema.parse(value);
  if (Buffer.byteLength(input.prompt, 'utf8') > 2000)
    throw new ApiError(
      400,
      'CREATOR_IMAGE_PROMPT_LIMIT',
      'Keep the image prompt within 2000 UTF-8 bytes.',
    );
  return input;
}

/** Direct Images API only. The supplied fetch MUST be the approved paid-request gate. */
export function createCreatorImageAdapter(
  config: { apiKey?: string } = {},
  gatedFetch?: typeof globalThis.fetch,
): CreatorImageAdapter {
  return {
    configured: Boolean(config.apiKey?.trim() && gatedFetch),
    model: CREATOR_IMAGE_MODEL,
    quote(value) {
      checkedInput(value);
      return { model: CREATOR_IMAGE_MODEL, size: '1024x1536', quality: 'medium', maxCostCents: 10 };
    },
    async generate(quote, external, beforeSubmit) {
      creatorImageQuoteSchema.parse(quote);
      checkedInput({
        prompt: quote.prompt,
        purpose: quote.purpose,
        ...(quote.parentFrameId ? { parentFrameId: quote.parentFrameId } : {}),
      });
      if (!config.apiKey?.trim() || !gatedFetch)
        throw new ApiError(
          503,
          'CREATOR_IMAGES_NOT_CONFIGURED',
          'Configure OpenAI image generation and its paid-request gate.',
        );
      const signal = AbortSignal.any([external, AbortSignal.timeout(180_000)]);
      signal.throwIfAborted();
      await beforeSubmit?.();
      signal.throwIfAborted();
      const response = await gatedFetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CREATOR_IMAGE_MODEL,
          prompt: quote.prompt,
          size: quote.size,
          quality: quote.quality,
          n: 1,
          output_format: 'png',
        }),
      });
      if (!response.ok)
        throw new ApiError(
          502,
          'CREATOR_IMAGE_REJECTED',
          `The image provider did not return an image (HTTP ${response.status}). Review the saved request before retrying.`,
        );
      const body = z
        .object({
          data: z
            .array(
              z.object({
                b64_json: z
                  .string()
                  .min(100)
                  .max(16 * 1024 * 1024),
              }),
            )
            .length(1),
          usage: z
            .object({
              input_tokens: z.number().int().nonnegative(),
              output_tokens: z.number().int().nonnegative(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .parse(
          JSON.parse((await readBounded(response, 18 * 1024 * 1024, signal)).toString('utf8')),
        );
      const encoded = body.data[0]!.b64_json;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
        throw new ApiError(
          502,
          'CREATOR_IMAGE_FORMAT',
          'The provider returned invalid image data.',
        );
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || bytes.length > 12 * 1024 * 1024)
        throw new ApiError(
          502,
          'CREATOR_IMAGE_SIZE',
          'The generated image exceeded its output bounds.',
        );
      const requestId = response.headers.get('x-request-id')?.slice(0, 200);
      return {
        bytes,
        ...(body.usage
          ? {
              usage: {
                inputTokens: body.usage.input_tokens,
                outputTokens: body.usage.output_tokens,
              },
            }
          : {}),
        ...(requestId ? { requestId } : {}),
      };
    },
  };
}

const imageStateSchema = z
  .object({
    quotes: z.array(creatorImageQuoteSchema).max(1000),
    jobs: z.array(creatorImageJobSchema).max(200),
  })
  .strict();
type ImageState = z.infer<typeof imageStateSchema>;
export function createCreatorImageService(
  directory: string,
  options: { adapter: CreatorImageAdapter; paid?: ApprovedImageOperation },
) {
  const stores = new Map<string, ReturnType<typeof productionStore<ImageState>>>();
  function storeFor(sessionId: string) {
    z.uuid().parse(sessionId);
    let pending = stores.get(sessionId);
    if (!pending) {
      pending = productionStore(join(directory, sessionId, 'storyboard.json'), imageStateSchema, {
        quotes: [],
        jobs: [],
      }).then(async (store) => {
        const previous = await store.read();
        if (previous.jobs.some((job) => job.status === 'running'))
          await store.mutate((state) => {
            for (const job of state.jobs)
              if (job.status === 'running') {
                job.status = 'failed';
                job.updatedAt = new Date().toISOString();
                job.error = {
                  code: 'CREATOR_IMAGE_INTERRUPTED',
                  message:
                    'Image generation was interrupted. Its provider outcome may be unknown; a retry requires a new quote and approval.',
                };
              }
          });
        return store;
      });
      stores.set(sessionId, pending);
    }
    return pending;
  }
  const pathFor = (sessionId: string, frameId: string) => {
    z.uuid().parse(sessionId);
    z.uuid().parse(frameId);
    return join(directory, sessionId, 'storyboards', `${frameId}.png`);
  };
  async function get(sessionId: string, frameId: string) {
    z.uuid().parse(frameId);
    const result = (await (await storeFor(sessionId)).read()).jobs.find(
      (job) => job.id === frameId,
    );
    if (!result)
      throw new ApiError(404, 'CREATOR_IMAGE_NOT_FOUND', 'This image is not in this creation.');
    return result;
  }
  async function verifyImage(sessionId: string, frameId: string) {
    const record = await get(sessionId, frameId);
    if (record.status !== 'succeeded' || !record.output)
      throw new ApiError(409, 'CREATOR_IMAGE_NOT_READY', 'Choose a completed generated frame.');
    const path = pathFor(sessionId, frameId);
    await verifyProductionFile(path, record.output);
    const bytes = await readFile(path);
    if (bytes.length !== record.output.bytes || sha(bytes) !== record.output.sha256)
      throw new ApiError(
        409,
        'CREATOR_PRODUCTION_INTEGRITY',
        'The saved generated frame changed while it was read.',
      );
    return { record, bytes };
  }
  return {
    configured: options.adapter.configured && Boolean(options.paid),
    model: options.adapter.model,
    get,
    verifyImage,
    async list(sessionId: string) {
      return (await (await storeFor(sessionId)).read()).jobs;
    },
    async quote(contextValue: CreatorImageContext, value: CreatorImageInput) {
      const context = creatorImageContextSchema.parse(contextValue),
        input = checkedInput(value);
      if (!options.adapter.configured || !options.paid)
        throw new ApiError(
          503,
          'CREATOR_IMAGES_NOT_CONFIGURED',
          'Image generation needs a configured provider and approved spending controls.',
        );
      const parent = input.parentFrameId
        ? await verifyImage(context.sessionId, input.parentFrameId)
        : undefined;
      const now = new Date();
      const identity = {
        ...context,
        ...input,
        ...(parent ? { parentFrameSha256: parent.record.output!.sha256 } : {}),
        ...options.adapter.quote(input),
      };
      const quote = creatorImageQuoteSchema.parse({
        ...identity,
        id: randomUUID(),
        promptHash: sha(input.prompt),
        inputHash: sha(JSON.stringify(identity)),
        currency: 'USD',
        priceSourceUrl: 'https://developers.openai.com/api/docs/guides/image-generation',
        pricingCheckedAt: '2026-11-15T00:00:00.000Z',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      });
      await (
        await storeFor(context.sessionId)
      ).mutate((state) => {
        state.quotes = state.quotes.filter((item) => item.expiresAt > now.toISOString()).slice(-99);
        state.quotes.push(quote);
      });
      return quote;
    },
    async generate(
      contextValue: CreatorImageContext,
      inputValue: CreatorImageGenerate,
      signal = new AbortController().signal,
      beforeSubmit?: () => Promise<void>,
    ) {
      const context = creatorImageContextSchema.parse(contextValue),
        input = creatorImageGenerateSchema.parse(inputValue);
      if (!options.adapter.configured || !options.paid)
        throw new ApiError(
          503,
          'CREATOR_IMAGES_NOT_CONFIGURED',
          'Image generation needs a configured provider and approved spending controls.',
        );
      const store = await storeFor(context.sessionId);
      const admitted = await store.mutate((state) => {
        const prior = state.jobs.find((job) => job.requestId === input.requestId);
        if (prior) {
          if (prior.quoteId !== input.quoteId)
            throw new ApiError(
              409,
              'CREATOR_IMAGE_REQUEST_CONFLICT',
              'This request ID belongs to another image quote.',
            );
          return { job: prior, quote: undefined };
        }
        const quote = state.quotes.find((item) => item.id === input.quoteId);
        if (state.jobs.some((job) => job.quoteId === input.quoteId))
          throw new ApiError(
            409,
            'CREATOR_IMAGE_QUOTE_USED',
            'This quote already belongs to a submitted image request. Request a fresh quote before another manual attempt.',
          );
        if (
          !quote ||
          quote.expiresAt <= new Date().toISOString() ||
          quote.sessionVersion !== context.sessionVersion ||
          quote.workflowVersion !== context.workflowVersion ||
          input.sessionVersion !== context.sessionVersion ||
          input.workflowVersion !== context.workflowVersion
        )
          throw new ApiError(
            409,
            'CREATOR_IMAGE_QUOTE_STALE',
            'Review a fresh image quote for the current creation.',
          );
        const attempt = state.jobs.filter((job) => job.inputHash === quote.inputHash).length + 1;
        if (attempt > 2)
          throw new ApiError(
            409,
            'CREATOR_IMAGE_ATTEMPT_LIMIT',
            'This exact image request has used both manual attempts. Change the direction before generating another frame.',
          );
        if (state.jobs.length >= 200)
          throw new ApiError(
            409,
            'CREATOR_IMAGE_LIMIT',
            'This creation has reached its saved image limit.',
          );
        const now = new Date().toISOString();
        const job = creatorImageJobSchema.parse({
          id: randomUUID(),
          sessionId: context.sessionId,
          requestId: input.requestId,
          quoteId: quote.id,
          inputHash: quote.inputHash,
          promptHash: quote.promptHash,
          prompt: quote.prompt,
          purpose: quote.purpose,
          parentFrameId: quote.parentFrameId,
          parentFrameSha256: quote.parentFrameSha256,
          model: quote.model,
          attempt,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        });
        state.jobs.push(job);
        return { job, quote };
      });
      if (!admitted.quote) return admitted.job;
      try {
        if (admitted.quote.parentFrameId) {
          const parent = await verifyImage(context.sessionId, admitted.quote.parentFrameId);
          if (parent.record.output!.sha256 !== admitted.quote.parentFrameSha256)
            throw new ApiError(
              409,
              'CREATOR_IMAGE_PARENT_CHANGED',
              'The parent frame changed. Review a new image quote.',
            );
        }
        signal.throwIfAborted();
        const result = await options.paid(admitted.quote, input.requestId, () =>
          options.adapter.generate(admitted.quote!, signal, beforeSubmit),
        );
        if (result.bytes.length < 100 || result.bytes.length > 12 * 1024 * 1024)
          throw new ApiError(
            502,
            'CREATOR_IMAGE_SIZE',
            'The generated image exceeded its output bounds.',
          );
        const image = sharp(result.bytes, { limitInputPixels: 2_000_000, failOn: 'warning' });
        const metadata = await image.metadata();
        if (
          metadata.format !== 'png' ||
          metadata.width !== 1024 ||
          metadata.height !== 1536 ||
          (metadata.pages ?? 1) !== 1
        )
          throw new ApiError(
            502,
            'CREATOR_IMAGE_FORMAT',
            'The generated frame does not match the approved PNG dimensions.',
          );
        await image.stats();
        const path = pathFor(context.sessionId, admitted.job.id),
          temporary = `${path}.${randomUUID()}.tmp`;
        await mkdir(join(directory, context.sessionId, 'storyboards'), { recursive: true });
        await writeFile(temporary, result.bytes, { flag: 'wx' });
        await rename(temporary, path);
        return await store.mutate((state) => {
          const job = state.jobs.find((item) => item.id === admitted.job.id)!;
          job.status = 'succeeded';
          job.updatedAt = new Date().toISOString();
          job.output = {
            mimeType: 'image/png',
            bytes: result.bytes.length,
            sha256: sha(result.bytes),
            width: 1024,
            height: 1536,
            provenance: 'generated_openai_api',
            ...(result.requestId ? { providerRequestId: result.requestId } : {}),
          };
          return job;
        });
      } catch (error) {
        return store.mutate((state) => {
          const job = state.jobs.find((item) => item.id === admitted.job.id)!;
          job.status = 'failed';
          job.updatedAt = new Date().toISOString();
          job.error = {
            code: error instanceof ApiError ? error.code : 'CREATOR_IMAGE_FAILED',
            message:
              error instanceof ApiError
                ? error.message
                : 'Image generation did not complete. The provider outcome may be unknown. Review before manually retrying.',
          };
          return job;
        });
      }
    },
  };
}
