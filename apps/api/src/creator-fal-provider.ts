import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { z } from 'zod';
import {
  creatorVideoPrompt,
  readBounded,
  type CreatorVideoConfig,
  type CreatorVideoProvider,
} from './creator-video-provider.js';
import { ApiError } from './errors.js';

const QUEUE = 'https://queue.fal.run';
const MODEL = 'fal-ai/bytedance/seedance/v1.5/pro';
const TASK_ROOT = `${QUEUE}/fal-ai/bytedance/requests/`;
const TASK_PREFIX = 'fal:seedance-1.5:';
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const submissionSchema = z.object({
  request_id: z.uuid(),
  response_url: z.string().max(300),
  status_url: z.string().max(300),
  cancel_url: z.string().max(300),
});
const statusSchema = z.object({
  status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']),
});
const outputSchema = z.object({
  video: z.object({ url: z.string().max(8192) }),
});

function invalidResponse(): ApiError {
  return new ApiError(
    502,
    'CREATOR_VIDEO_INVALID_RESPONSE',
    'The video provider returned an invalid response.',
  );
}

function taskUuid(id: string): string {
  if (!id.startsWith(TASK_PREFIX))
    throw new ApiError(400, 'CREATOR_TASK_ID_INVALID', 'Invalid fal video task identity.');
  const result = z.uuid().safeParse(id.slice(TASK_PREFIX.length));
  if (!result.success)
    throw new ApiError(400, 'CREATOR_TASK_ID_INVALID', 'Invalid fal video task identity.');
  return result.data;
}

function operationUrl(value: string, expected: string): string {
  // Queue follow-up URLs use owner/app, not the submitted model subpath.
  // https://fal.ai/docs/documentation/model-apis/inference/queue
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse();
  }
  if (url.href !== expected || url.username || url.password || url.port)
    throw new ApiError(
      502,
      'CREATOR_VIDEO_URL_REJECTED',
      'The video provider returned an unsupported task URL.',
    );
  return expected;
}

function artifactUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse();
  }
  // fal documents its output files under https://v3[b].fal.media/files/...
  // https://fal.ai/docs/documentation/model-apis/media-expiration
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname.endsWith('.fal.media') ||
    !url.pathname.startsWith('/files/') ||
    url.hash
  )
    throw new ApiError(
      502,
      'CREATOR_VIDEO_URL_REJECTED',
      'The video provider returned an unsupported artifact URL.',
    );
  return url;
}

/** Seedance 1.5 Pro, 720p, silent. Submission is never automatically replayed. */
export function createFalCreatorVideoProvider(
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
    pollMs > 60_000
  )
    throw new ApiError(503, 'CREATOR_CONFIGURATION', 'Invalid video provider deadline.');
  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  };

  async function json(
    url: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetcher(url, {
      method,
      headers,
      signal,
      redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = await readBounded(response, 256 * 1024, signal);
    if (!response.ok)
      throw new ApiError(
        response.status === 429 ? 429 : 502,
        'CREATOR_VIDEO_PROVIDER_ERROR',
        'The video provider rejected the request. Check access, balance and content restrictions. No paid request was automatically repeated.',
      );
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw invalidResponse();
    }
  }

  async function cancel(id: string): Promise<void> {
    const uuid = taskUuid(id);
    if (!apiKey) return;
    try {
      const signal = AbortSignal.timeout(10_000);
      const response = await fetcher(`${TASK_ROOT}${uuid}/cancel`, {
        method: 'PUT',
        headers,
        signal,
        redirect: 'error',
      });
      const bytes = await readBounded(response, 256 * 1024, signal);
      const result = z
        .object({ status: z.literal('OK') })
        .safeParse(JSON.parse(bytes.toString('utf8')));
      // 202/CANCELLATION_REQUESTED can still complete and incur the full charge.
      if (response.status !== 200 || !result.success) throw invalidResponse();
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
    profile: {
      provider: 'fal',
      model: 'seedance-v1.5-pro',
      minSeconds: 4,
      maxSeconds: 10,
      rateCentsPerSecond: 5,
      priceSourceUrl: 'https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
      pricingCheckedAt: '2026-11-14',
    },
    cancel,
    async generate(request) {
      if (!apiKey)
        throw new ApiError(
          503,
          'CREATOR_VIDEO_NOT_CONFIGURED',
          'Set FAL_KEY to generate real clips.',
        );
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]);
      let taskId: string | undefined,
        persisted = false;
      try {
        signal.throwIfAborted();
        if (
          !Number.isInteger(request.clip.seconds) ||
          request.clip.seconds < 4 ||
          request.clip.seconds > 10
        )
          throw new ApiError(
            400,
            'CREATOR_CLIP_DURATION',
            'Use a clip duration from 4 to 10 seconds.',
          );
        const prompt = creatorVideoPrompt(request.clip);
        if (!prompt.trim() || prompt.length > 1000)
          throw new ApiError(
            400,
            'CREATOR_PROMPT_TOO_LONG',
            'The combined visual, camera and lighting prompt must stay within 1,000 characters.',
          );
        let imageUrl: string | undefined;
        if (request.image) {
          if (request.image.length > MAX_IMAGE_BYTES)
            throw new ApiError(
              413,
              'CREATOR_IMAGE_TOO_LARGE',
              'Resize this reference image before generation.',
            );
          let normalized: Buffer;
          try {
            // Preserve the supplied composition within a portrait canvas; no generated fill.
            normalized = await sharp(request.image, { limitInputPixels: 40_000_000 })
              .rotate()
              .resize(720, 1280, { fit: 'contain', background: '#000000' })
              .jpeg({ quality: 88 })
              .toBuffer();
          } catch {
            throw new ApiError(
              400,
              'CREATOR_IMAGE_INVALID',
              'The reference image could not be prepared.',
            );
          }
          imageUrl = `data:image/jpeg;base64,${normalized.toString('base64')}`;
          if (imageUrl.length > 5 * 1024 * 1024)
            throw new ApiError(
              413,
              'CREATOR_IMAGE_TOO_LARGE',
              'Resize this reference image before generation.',
            );
        }
        signal.throwIfAborted();
        // Recheck current approval after asynchronous image preparation, just before billing.
        await request.beforeSubmit?.();
        signal.throwIfAborted();
        const rawSubmission = await json(
          `${QUEUE}/${MODEL}/${imageUrl ? 'image-to-video' : 'text-to-video'}`,
          'POST',
          signal,
          {
            prompt,
            aspect_ratio: '9:16',
            resolution: '720p',
            duration: String(request.clip.seconds),
            generate_audio: false,
            enable_safety_checker: true,
            ...(imageUrl ? { image_url: imageUrl } : {}),
          },
        );
        const identifier = z.object({ request_id: z.uuid() }).safeParse(rawSubmission);
        if (!identifier.success) throw invalidResponse();
        const taskRoot = `${TASK_ROOT}${identifier.data.request_id}`;
        taskId = `${TASK_PREFIX}${identifier.data.request_id}`;
        // Persist even if the supplied operation URLs are malformed: paid task may exist.
        await request.onSubmitted(taskId);
        persisted = true;
        const submission = submissionSchema.safeParse(rawSubmission);
        if (!submission.success) throw invalidResponse();
        const submitted = submission.data;
        const responseUrl = operationUrl(submitted.response_url, taskRoot),
          statusUrl = operationUrl(submitted.status_url, `${taskRoot}/status`);
        operationUrl(submitted.cancel_url, `${taskRoot}/cancel`);
        for (;;) {
          await delay(pollMs, undefined, { signal });
          const status = statusSchema.safeParse(await json(statusUrl, 'GET', signal));
          if (!status.success) throw invalidResponse();
          if (status.data.status !== 'COMPLETED') continue;
          const output = outputSchema.safeParse(await json(responseUrl, 'GET', signal));
          if (!output.success) throw invalidResponse();
          const response = await fetcher(artifactUrl(output.data.video.url), {
            signal,
            redirect: 'error',
          });
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
          const bytes = await readBounded(response, MAX_VIDEO_BYTES, signal);
          if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp')
            throw new ApiError(
              502,
              'CREATOR_VIDEO_CONTENT_TYPE',
              'The provider artifact was not an MP4.',
            );
          return bytes;
        }
      } catch (error) {
        if (taskId && (signal.aborted || !persisted)) await cancel(taskId).catch(() => undefined);
        if (signal.aborted)
          throw new ApiError(
            request.signal.aborted ? 409 : 504,
            request.signal.aborted ? 'CREATOR_CANCELED' : 'CREATOR_VIDEO_TIMEOUT',
            request.signal.aborted
              ? 'Creation was canceled. Submitted clips may continue billing.'
              : 'The video provider deadline expired. A submitted clip may continue billing.',
          );
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          502,
          'CREATOR_VIDEO_PROVIDER_ERROR',
          'The video provider could not complete this request. No paid request was automatically repeated.',
        );
      }
    },
  };
}
