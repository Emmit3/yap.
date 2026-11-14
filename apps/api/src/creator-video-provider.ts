import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { z } from 'zod';
import type { CreatorClip } from '@yap/contracts/creator';
import { ApiError } from './errors.js';

export interface CreatorVideoRequest {
  clip: CreatorClip;
  image?: Buffer;
  signal: AbortSignal;
  /** Final revision/approval check after preprocessing and before the paid POST. */
  beforeSubmit?(): Promise<void>;
  onSubmitted(id: string): Promise<void>;
}
export interface CreatorVideoProvider {
  readonly configured: boolean;
  readonly profile?: CreatorVideoProfile;
  generate(request: CreatorVideoRequest): Promise<Buffer>;
  cancel(id: string): Promise<void>;
}
export interface CreatorVideoProfile {
  provider: 'fal' | 'runway';
  model: 'seedance-v1.5-pro' | 'gen4.5';
  minSeconds: number;
  maxSeconds: number;
  /** Conservative reservation ceiling, not the provider's final invoice. */
  rateCentsPerSecond: number;
  priceSourceUrl: string;
  pricingCheckedAt: string;
}
export interface CreatorVideoConfig {
  provider?: 'fal' | 'runway';
  apiKey?: string;
  timeoutMs?: number;
  pollMs?: number;
}
const ROOT = 'https://api.dev.runwayml.com/v1';
export function creatorVideoPrompt(clip: CreatorClip): string {
  return `${clip.prompt}\nCamera: ${clip.camera}\nLighting: ${clip.lighting}\nOne continuous cinematic shot. No lettering, captions, logos added, speech or music.`;
}
const taskSchema = z.object({
  id: z.uuid(),
  status: z.enum([
    'PENDING',
    'THROTTLED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELED',
    'CANCELLED',
  ]),
  output: z.array(z.url()).max(10).optional(),
  failure: z.string().max(4000).optional(),
  failureCode: z.string().max(200).optional(),
});

export async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new ApiError(
      502,
      'CREATOR_RESPONSE_LIMIT',
      'The provider response exceeded its size limit.',
    );
  }
  if (!response.body)
    throw new ApiError(502, 'CREATOR_EMPTY_RESPONSE', 'The provider returned an empty response.');
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes)
        throw new ApiError(
          502,
          'CREATOR_RESPONSE_LIMIT',
          'The provider response exceeded its size limit.',
        );
      parts.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(parts);
}

/** Real Runway task API. A timed-out POST is never automatically replayed. */
export function createCreatorVideoProvider(
  config: CreatorVideoConfig = {},
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): CreatorVideoProvider {
  const apiKey = config.apiKey?.trim(),
    timeout = config.timeoutMs ?? 15 * 60 * 1000,
    pollMs = config.pollMs ?? 5000;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 30 * 60 * 1000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 60000
  )
    throw new ApiError(503, 'CREATOR_CONFIGURATION', 'Invalid video provider deadline.');
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'X-Runway-Version': '2024-11-06',
    'Content-Type': 'application/json',
  };
  async function json(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetcher(`${ROOT}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    const bytes = await readBounded(response, 256 * 1024, signal);
    if (!response.ok)
      throw new ApiError(
        response.status === 429 ? 429 : 502,
        'CREATOR_VIDEO_PROVIDER_ERROR',
        response.status === 429
          ? 'The video provider is busy. No paid request was automatically repeated.'
          : 'The video provider rejected the request. Check its configuration, balance and content restrictions.',
      );
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ApiError(
        502,
        'CREATOR_VIDEO_INVALID_RESPONSE',
        'The video provider returned invalid JSON.',
      );
    }
  }
  async function cancel(id: string): Promise<void> {
    z.uuid().parse(id);
    if (!apiKey) return;
    const signal = AbortSignal.timeout(10000);
    const response = await fetcher(`${ROOT}/tasks/${id}`, {
      method: 'DELETE',
      headers,
      signal,
      redirect: 'error',
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404)
      throw new ApiError(
        502,
        'CREATOR_CANCEL_UNCONFIRMED',
        'The provider did not confirm cancellation. It may continue billing.',
      );
  }
  return {
    configured: Boolean(apiKey),
    profile: {
      provider: 'runway',
      model: 'gen4.5',
      minSeconds: 2,
      maxSeconds: 10,
      rateCentsPerSecond: 16,
      priceSourceUrl: 'https://docs.dev.runwayml.com/guides/pricing/',
      pricingCheckedAt: '2026-11-14T00:00:00.000Z',
    },
    cancel,
    async generate(request) {
      if (!apiKey)
        throw new ApiError(
          503,
          'CREATOR_VIDEO_NOT_CONFIGURED',
          'Set RUNWAYML_API_SECRET to generate real clips.',
        );
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]);
      let taskId: string | undefined;
      try {
        signal.throwIfAborted();
        let promptImage: string | undefined;
        if (request.image) {
          const normalized = await sharp(request.image, { limitInputPixels: 40_000_000 })
            .rotate()
            .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 88 })
            .toBuffer();
          promptImage = `data:image/jpeg;base64,${normalized.toString('base64')}`;
          if (promptImage.length > 5 * 1024 * 1024)
            throw new ApiError(
              413,
              'CREATOR_IMAGE_TOO_LARGE',
              'Resize this reference image before generation.',
            );
        }
        const promptText = creatorVideoPrompt(request.clip);
        if (promptText.length > 1000)
          throw new ApiError(
            400,
            'CREATOR_PROMPT_TOO_LONG',
            'The combined visual, camera and lighting prompt must stay within 1,000 characters.',
          );
        await request.beforeSubmit?.();
        signal.throwIfAborted();
        const result = z.object({ id: z.uuid() }).parse(
          await json(promptImage ? '/image_to_video' : '/text_to_video', 'POST', signal, {
            model: 'gen4.5',
            promptText,
            ratio: '720:1280',
            duration: request.clip.seconds,
            ...(promptImage ? { promptImage } : {}),
          }),
        );
        taskId = result.id;
        await request.onSubmitted(taskId);
        for (;;) {
          await delay(pollMs, undefined, { signal });
          const task = taskSchema.parse(await json(`/tasks/${taskId}`, 'GET', signal));
          if (task.status === 'FAILED' || task.status === 'CANCELED' || task.status === 'CANCELLED')
            throw new ApiError(
              502,
              'CREATOR_CLIP_GENERATION_FAILED',
              `The video provider did not complete this clip${task.failureCode ? ` (${task.failureCode.slice(0, 80)})` : ''}. No paid request was automatically repeated.`,
            );
          if (task.status !== 'SUCCEEDED') continue;
          const value = task.output?.[0];
          if (!value)
            throw new ApiError(
              502,
              'CREATOR_VIDEO_MISSING',
              'The provider reported success without a video.',
            );
          const url = new URL(value);
          // Provider artifact URLs are not user URLs. Restrict to its documented HTTPS CDN.
          if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.port ||
            !(
              url.hostname === 'dnznrvs05pmza.cloudfront.net' ||
              url.hostname.endsWith('.runwayml.com') ||
              url.hostname.endsWith('.runway.com')
            )
          )
            throw new ApiError(
              502,
              'CREATOR_VIDEO_URL_REJECTED',
              'The provider returned an unsupported artifact host.',
            );
          const response = await fetcher(url, { signal, redirect: 'error' });
          if (!response.ok) {
            await response.body?.cancel();
            throw new ApiError(
              502,
              'CREATOR_VIDEO_DOWNLOAD_FAILED',
              'The generated video could not be downloaded.',
            );
          }
          const contentType = response.headers.get('content-type') ?? '';
          if (!/^(video\/mp4|application\/octet-stream)(;|$)/i.test(contentType)) {
            await response.body?.cancel();
            throw new ApiError(
              502,
              'CREATOR_VIDEO_CONTENT_TYPE',
              'The provider artifact was not an MP4.',
            );
          }
          return await readBounded(response, 100 * 1024 * 1024, signal);
        }
      } catch (error) {
        if (taskId && signal.aborted) await cancel(taskId).catch(() => undefined);
        throw error;
      }
    },
  };
}
