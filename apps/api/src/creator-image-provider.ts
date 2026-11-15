import sharp from 'sharp';
import { z } from 'zod';
import {
  creatorImageSettingsSchema,
  type CreatorImageSettings,
} from '@yap/contracts/creator-images';
import { ApiError } from './errors.js';
import { readBounded } from './creator-video-provider.js';

const ROOT = 'https://api.openai.com/v1/images';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const WIDTH = 864;
const HEIGHT = 1536;

export interface CreatorImageUsage {
  textInputTokens: number;
  imageInputTokens: number;
  outputTokens: number;
}
export interface CreatorImageProvider {
  readonly configured: boolean;
  generate(request: {
    settings: CreatorImageSettings;
    image?: Buffer;
    signal: AbortSignal;
    /** The job service owns its reservation and rechecks current approval here. */
    beforeSubmit(): Promise<void>;
  }): Promise<{
    bytes: Buffer;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    usage?: CreatorImageUsage;
  }>;
}

function invalidInput(): ApiError {
  return new ApiError(
    400,
    'CREATOR_IMAGE_INPUT_INVALID',
    'Use one valid still PNG, JPEG or WebP reference under 10 MB and 40 megapixels.',
  );
}
function invalidOutput(): ApiError {
  return new ApiError(
    502,
    'CREATOR_IMAGE_OUTPUT_INVALID',
    'The image provider did not return one valid portrait image. No request was repeated.',
  );
}
function rasterFormat(bytes: Buffer): 'png' | 'jpeg' | 'webp' | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return undefined;
}

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const usageSchema = z
  .object({
    input_tokens: counter,
    output_tokens: counter,
    total_tokens: counter.optional(),
    input_tokens_details: z.object({ text_tokens: counter, image_tokens: counter }).passthrough(),
    output_tokens_details: z
      .object({ text_tokens: counter, image_tokens: counter })
      .passthrough()
      .optional(),
  })
  .passthrough();
function knownUsage(value: unknown): CreatorImageUsage | undefined {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const usage = parsed.data;
  const input = usage.input_tokens_details.text_tokens + usage.input_tokens_details.image_tokens;
  const total = usage.input_tokens + usage.output_tokens;
  const output = usage.output_tokens_details;
  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(total) ||
    input !== usage.input_tokens ||
    (usage.total_tokens !== undefined && usage.total_tokens !== total) ||
    (output && output.text_tokens + output.image_tokens !== usage.output_tokens)
  )
    return undefined;
  return {
    textInputTokens: usage.input_tokens_details.text_tokens,
    imageInputTokens: usage.input_tokens_details.image_tokens,
    outputTokens: usage.output_tokens,
  };
}

/** Direct Images API only. The caller reserves spending; this adapter never retries a paid POST. */
export function createCreatorImageProvider(
  config: { apiKey?: string; timeoutMs?: number } = {},
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): CreatorImageProvider {
  const apiKey = config.apiKey?.trim();
  const timeoutMs = config.timeoutMs ?? 180_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    throw new ApiError(503, 'CREATOR_IMAGE_CONFIGURATION', 'Use a valid image-provider deadline.');
  return {
    configured: Boolean(apiKey),
    async generate({ settings, image, signal: external, beforeSubmit }) {
      if (!apiKey)
        throw new ApiError(
          503,
          'CREATOR_IMAGE_NOT_CONFIGURED',
          'Set OPENAI_API_KEY on the API server to generate or edit an image.',
        );
      const signal = AbortSignal.any([external, AbortSignal.timeout(timeoutMs)]);
      const checkCanceled = () => {
        if (external.aborted)
          throw new ApiError(409, 'CREATOR_CANCELED', 'Image creation was canceled.');
        if (signal.aborted)
          throw new ApiError(504, 'CREATOR_IMAGE_TIMEOUT', 'Image creation exceeded its deadline.');
      };
      checkCanceled();
      const parsed = creatorImageSettingsSchema.safeParse(settings);
      if (!parsed.success)
        throw new ApiError(
          400,
          'CREATOR_IMAGE_SETTINGS_INVALID',
          'Use the supported image model, portrait size, quality and prompt settings.',
        );
      if ((parsed.data.parentVariantId || parsed.data.sourceAssetId) && image === undefined)
        throw invalidInput();
      let reference: Buffer | undefined;
      if (image !== undefined) {
        if (!Buffer.isBuffer(image) || !image.length || image.length > MAX_IMAGE_BYTES)
          throw invalidInput();
        const format = rasterFormat(image);
        if (!format) throw invalidInput();
        try {
          const source = sharp(image, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'warning' });
          const metadata = await source.metadata();
          checkCanceled();
          if (
            metadata.format !== format ||
            !metadata.width ||
            !metadata.height ||
            (metadata.pages ?? 1) > 1
          )
            throw invalidInput();
          reference = await source
            .rotate()
            .flatten({ background: '#ffffff' })
            .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 90 })
            .toBuffer();
          checkCanceled();
          if (!reference.length || reference.length > MAX_IMAGE_BYTES) throw invalidInput();
        } catch {
          checkCanceled();
          throw invalidInput();
        }
      }
      const body = JSON.stringify({
        model: parsed.data.model,
        prompt: parsed.data.prompt,
        n: 1,
        size: parsed.data.size,
        quality: parsed.data.quality,
        complexity: parsed.data.complexity,
        background: 'opaque',
        output_format: 'png',
        ...(reference
          ? { images: [{ image_url: `data:image/jpeg;base64,${reference.toString('base64')}` }] }
          : {}),
      });
      // Preprocessing above awaits; the service must recheck approval immediately before dispatch.
      try {
        await beforeSubmit();
      } catch (error) {
        checkCanceled();
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          409,
          'CREATOR_IMAGE_SUBMISSION_BLOCKED',
          'Image submission was stopped before contacting the provider.',
        );
      }
      checkCanceled();
      let responseBytes: Buffer;
      try {
        const response = await fetcher(`${ROOT}/${reference ? 'edits' : 'generations'}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal,
          redirect: 'error',
        });
        if ([400, 401, 403, 404, 429].includes(response.status)) {
          void response.body?.cancel().catch(() => undefined);
          throw new ApiError(
            response.status === 429 ? 429 : 502,
            'CREATOR_IMAGE_REJECTED',
            'The image provider rejected the request before generation. Check access, balance and image settings.',
          );
        }
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error();
        }
        responseBytes = await readBounded(response, MAX_RESPONSE_BYTES, signal);
      } catch (error) {
        checkCanceled();
        if (error instanceof ApiError && error.code === 'CREATOR_IMAGE_REJECTED') throw error;
        throw new ApiError(
          502,
          'CREATOR_IMAGE_PROVIDER_ERROR',
          'The image provider did not complete the request. No paid request was repeated.',
        );
      }
      checkCanceled();
      let value: unknown;
      try {
        value = JSON.parse(responseBytes.toString('utf8'));
      } catch {
        throw invalidOutput();
      }
      const result = z
        .object({
          data: z.array(z.object({ b64_json: z.string().min(4) }).passthrough()).length(1),
          usage: z.unknown().optional(),
        })
        .passthrough()
        .safeParse(value);
      if (!result.success) throw invalidOutput();
      const encoded = result.data.data[0]!.b64_json;
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      if (
        encoded.length % 4 !== 0 ||
        (encoded.length / 4) * 3 - padding > MAX_IMAGE_BYTES ||
        /[^A-Za-z0-9+/=]/.test(encoded)
      )
        throw invalidOutput();
      const decoded = Buffer.from(encoded, 'base64');
      if (!decoded.length || decoded.toString('base64') !== encoded) throw invalidOutput();
      const format = rasterFormat(decoded);
      if (!format) throw invalidOutput();
      let bytes: Buffer;
      try {
        const output = sharp(decoded, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'warning' });
        const metadata = await output.metadata();
        checkCanceled();
        if (
          metadata.format !== format ||
          metadata.width !== WIDTH ||
          metadata.height !== HEIGHT ||
          (metadata.pages ?? 1) > 1 ||
          (metadata.orientation !== undefined && metadata.orientation !== 1)
        )
          throw invalidOutput();
        // Normalize the served raster format and remove accidental alpha or metadata.
        bytes = await output.flatten({ background: '#ffffff' }).png().toBuffer();
        checkCanceled();
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw invalidOutput();
      } catch {
        checkCanceled();
        throw invalidOutput();
      }
      const usage = knownUsage(result.data.usage);
      return { bytes, mimeType: 'image/png', ...(usage ? { usage } : {}) };
    },
  };
}
