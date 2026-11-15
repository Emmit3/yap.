import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { z } from 'zod';
import {
  creatorVideoPrompt,
  readBounded,
  type CreatorVideoConfig,
  type CreatorVideoProfile,
  type CreatorVideoProvider,
} from './creator-video-provider.js';
import { ApiError } from './errors.js';

const ROOT = 'https://queue.fal.run/bytedance/seedance-2.5';
const TASK_PREFIX = 'fal:seedance-2.5:';
const submitSchema = z.object({ request_id: z.uuid() });
const statusSchema = z.object({ status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']) });
const resultSchema = z.object({ video: z.object({ url: z.url() }) });
const contentRejectionSchema = z.object({ type: z.literal('content_policy_violation') });

function isContentPolicyRejection(bytes: Buffer): boolean {
  try {
    const parsed = z.object({ detail: z.unknown() }).safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) return false;
    const details = Array.isArray(parsed.data.detail) ? parsed.data.detail : [parsed.data.detail];
    return details.some((detail) => contentRejectionSchema.safeParse(detail).success);
  } catch {
    return false;
  }
}

/** Seedance 2.5's bounded 720p queue API. A paid POST is never replayed. */
export function createSeedance25CreatorVideoProvider(
  config: CreatorVideoConfig = {},
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): CreatorVideoProvider {
  const apiKey = config.apiKey?.trim(),
    timeout = config.timeoutMs ?? 15 * 60 * 1000,
    pollMs = config.pollMs ?? 5000,
    ratio = config.ratio ?? '720:1280';
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 30 * 60 * 1000 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 60000 ||
    !['720:1280', '1280:720'].includes(ratio)
  )
    throw new ApiError(503, 'CREATOR_CONFIGURATION', 'Invalid fal video configuration.');
  const headers = { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };
  const landscape = ratio === '1280:720';
  const profile: CreatorVideoProfile = {
    provider: 'fal',
    model: 'seedance-2.5',
    id: landscape ? 'fal-seedance2.5-landscape' : 'fal-seedance2.5-portrait',
    label: `fal Seedance 2.5 · ${landscape ? 'landscape' : 'portrait'} 720p`,
    nativeWidth: landscape ? 1280 : 720,
    nativeHeight: landscape ? 720 : 1280,
    ratio,
    requiresImage: false,
    minSeconds: 4,
    maxSeconds: 10,
    // $0.0214 / 1,000 tokens; 720p at 24fps is $0.46224/s. Reserve $0.50/s.
    rateCentsPerSecond: 50,
    priceSourceUrl: 'https://fal.ai/learn/tools/how-to-access-seedance-2-5-on-fal',
    pricingCheckedAt: '2026-11-15T00:00:00.000Z',
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
    if (!response.ok) {
      if (response.status === 422 && isContentPolicyRejection(bytes))
        throw new ApiError(
          422,
          'CREATOR_VIDEO_CONTENT_REJECTED',
          'The video provider rejected this content. Choose a different suitable reference photo and review the shot before trying again.',
        );
      throw new ApiError(
        response.status === 429 ? 429 : 502,
        'CREATOR_VIDEO_PROVIDER_ERROR',
        response.status === 429
          ? 'The video provider is busy. No paid request was automatically repeated.'
          : 'The video provider rejected the request. Check its configuration, balance and content restrictions.',
      );
    }
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
    const parsed = id.startsWith(TASK_PREFIX)
      ? z.uuid().safeParse(id.slice(TASK_PREFIX.length))
      : undefined;
    if (!parsed?.success)
      throw new ApiError(400, 'CREATOR_TASK_ID_INVALID', 'Invalid fal video task identity.');
    if (!apiKey) return;
    try {
      const result = await json(
        `/requests/${parsed.data}/cancel`,
        'PUT',
        AbortSignal.timeout(10000),
      );
      if (!z.object({ status: z.literal('OK') }).safeParse(result).success)
        throw new Error('Unconfirmed cancellation');
    } catch {
      throw new ApiError(
        502,
        'CREATOR_CANCEL_UNCONFIRMED',
        'The provider did not confirm cancellation. It may continue billing.',
      );
    }
  }
  return {
    configured: Boolean(apiKey),
    profile,
    cancel,
    async generate(request) {
      if (!apiKey)
        throw new ApiError(
          503,
          'CREATOR_VIDEO_NOT_CONFIGURED',
          'Set FAL_KEY with usable API credits to generate real clips.',
        );
      if (request.clip.videoProfileId !== undefined && request.clip.videoProfileId !== profile.id)
        throw new ApiError(
          409,
          'CREATOR_PROVIDER_CHANGED',
          'This shot uses a different provider profile. Request a new quote.',
        );
      if (
        !Number.isInteger(request.clip.seconds) ||
        request.clip.seconds < profile.minSeconds ||
        request.clip.seconds > profile.maxSeconds
      )
        throw new ApiError(
          400,
          'CREATOR_CLIP_DURATION',
          'Use a whole Seedance 2.5 shot duration from 4 to 10 seconds.',
        );
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]);
      let taskId: string | undefined;
      try {
        signal.throwIfAborted();
        let imageUrl: string | undefined;
        if (request.image) {
          const normalized = await sharp(request.image, { limitInputPixels: 40_000_000 })
            .rotate()
            .resize({
              width: profile.nativeWidth!,
              height: profile.nativeHeight!,
              fit: 'cover',
              position: 'center',
            })
            .flatten({ background: '#000000' })
            .jpeg({ quality: 88 })
            .toBuffer();
          imageUrl = `data:image/jpeg;base64,${normalized.toString('base64')}`;
          if (Buffer.byteLength(imageUrl, 'utf8') > 5 * 1024 * 1024)
            throw new ApiError(
              413,
              'CREATOR_IMAGE_TOO_LARGE',
              'Resize this reference image before generation.',
            );
        }
        const prompt = creatorVideoPrompt(request.clip);
        if (prompt.length > 1000)
          throw new ApiError(
            400,
            'CREATOR_PROMPT_TOO_LONG',
            'The combined visual, camera and lighting prompt must stay within 1,000 characters.',
          );
        const body = {
          prompt,
          resolution: '720p',
          // The official OpenAPI schema requires string duration values.
          duration: String(request.clip.seconds),
          aspect_ratio: imageUrl ? 'auto' : landscape ? '16:9' : '9:16',
          generate_audio: false,
          codec: 'H264',
          bitrate_mode: 'standard',
          draft: false,
          ...(imageUrl ? { image_url: imageUrl } : {}),
        };
        await request.beforeSubmit?.();
        signal.throwIfAborted();
        const submitted = submitSchema.parse(
          await json(imageUrl ? '/image-to-video' : '/text-to-video', 'POST', signal, body),
        );
        taskId = `${TASK_PREFIX}${submitted.request_id}`;
        await request.onSubmitted(taskId);
        // Build fixed owner/app paths. Never follow response-provided routing URLs.
        const taskPath = `/requests/${submitted.request_id}`;
        for (;;) {
          await delay(pollMs, undefined, { signal });
          const status = statusSchema.parse(await json(`${taskPath}/status`, 'GET', signal));
          if (status.status !== 'COMPLETED') continue;
          const result = resultSchema.parse(await json(taskPath, 'GET', signal));
          const url = new URL(result.video.url);
          const trustedHost =
            url.hostname === 'fal.media' ||
            url.hostname.endsWith('.fal.media') ||
            (url.hostname === 'storage.googleapis.com' &&
              url.pathname.startsWith('/falserverless/'));
          if (url.protocol !== 'https:' || url.username || url.password || url.port || !trustedHost)
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
          if (
            !/^(video\/mp4|application\/octet-stream)(;|$)/i.test(
              response.headers.get('content-type') ?? '',
            )
          ) {
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
