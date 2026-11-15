import { apiErrorSchema, durationSchema, platformSchema } from '@yap/contracts';
import {
  workflowResponseSchema,
  workflowsResponseSchema,
  workflowSchema,
  workflowScriptSchema,
  type CreateWorkflowInput,
  type PrepareWorkflowInput,
  type RefineWorkflowInput,
  type UpdateWorkflowScenesInput,
  type UpdateWorkflowScriptInput,
} from '@yap/contracts/workflow';
import {
  renderJobResponseSchema,
  renderJobsResponseSchema,
  type RenderJob,
} from '@yap/contracts/render';

export type WorkflowResponse = ReturnType<typeof workflowResponseSchema.parse>;
export type PromoCreateInput = CreateWorkflowInput;
export type PromoRefineInput = RefineWorkflowInput;
export type PublishKit = {
  workflowId: string;
  workflowVersion: number;
  platform: 'instagram' | 'tiktok' | 'youtube';
  caption: string;
  script: string;
  video: {
    jobId: string;
    url: string;
    width: 1080;
    height: 1920;
    duration: 15 | 20 | 30 | 60;
    hasAudio: false;
  };
  ready: true;
  automaticPosting: false;
};

export class PromoApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly code = 'REQUEST_FAILED',
  ) {
    super(message);
    this.name = 'PromoApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePublishKit(value: unknown): PublishKit {
  if (!isRecord(value) || !isRecord(value.video)) throw new Error('Invalid publish handoff.');
  const media = value.video;
  if (
    value.ready !== true ||
    value.automaticPosting !== false ||
    media.hasAudio !== false ||
    media.width !== 1080 ||
    media.height !== 1920 ||
    typeof value.script !== 'string' ||
    typeof media.url !== 'string' ||
    !media.url.startsWith('/api/workflows/')
  ) {
    throw new Error('Invalid publish handoff.');
  }
  return {
    workflowId: workflowSchema.shape.id.parse(value.workflowId),
    workflowVersion: workflowSchema.shape.version.parse(value.workflowVersion),
    platform: platformSchema.parse(value.platform),
    caption: workflowScriptSchema.shape.caption.parse(value.caption),
    script: value.script,
    video: {
      jobId: renderJobResponseSchema.shape.job.shape.id.parse(media.jobId),
      url: media.url,
      width: 1080,
      height: 1920,
      duration: durationSchema.parse(media.duration),
      hasAudio: false,
    },
    ready: true,
    automaticPosting: false,
  };
}

export function isPromoAbort(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export const promoMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'This change could not be completed. Try again.';

export function createPromoApi(origin = '') {
  const root = `${origin.replace(/\/$/, '')}/api/workflows`;
  const path = (id: string) => `/${encodeURIComponent(id)}`;
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function request<T>(
    suffix: string,
    schema: { parse(value: unknown): T },
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new PromoApiError(
            'The server took too long to respond. Reload the saved promo before retrying this change.',
            0,
            'REQUEST_TIMEOUT',
          ),
        ),
      90_000,
    );
    try {
      const response = await fetch(`${root}${suffix}`, { ...init, signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const result = apiErrorSchema.safeParse(payload);
        const message = result.success
          ? [
              result.data.error.message,
              ...(result.data.error.details?.map((detail) => `${detail.path}: ${detail.message}`) ??
                []),
            ].join(' ')
          : `Request failed (${response.status}).`;
        throw new PromoApiError(
          message,
          response.status,
          result.success ? result.data.error.code : 'REQUEST_FAILED',
        );
      }
      try {
        return schema.parse(payload);
      } catch {
        throw new PromoApiError(
          'The API returned an unexpected response. Check that the frontend and API use the same contracts.',
          response.status,
          'INVALID_RESPONSE',
        );
      }
    } catch (error) {
      if (controller.signal.aborted)
        throw controller.signal.reason ?? new DOMException('Request canceled.', 'AbortError');
      if (error instanceof PromoApiError) throw error;
      throw new PromoApiError(
        'Could not reach the promo server. Check that the API is running, then try again.',
        0,
        'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  const api = {
    create: (input: PromoCreateInput, signal?: AbortSignal) =>
      request('', workflowResponseSchema, json('POST', input), signal),
    get: (id: string, signal?: AbortSignal) =>
      request(path(id), workflowResponseSchema, {}, signal),
    async list(q = '', signal?: AbortSignal) {
      return (
        await request(q ? `?q=${encodeURIComponent(q)}` : '', workflowsResponseSchema, {}, signal)
      ).workflows;
    },
    refine: (id: string, input: PromoRefineInput, signal?: AbortSignal) =>
      request(`${path(id)}/refine`, workflowResponseSchema, json('POST', input), signal),
    prepare: (id: string, input: PrepareWorkflowInput, signal?: AbortSignal) =>
      request(`${path(id)}/prepare`, workflowResponseSchema, json('POST', input), signal),
    updateScript: (id: string, input: UpdateWorkflowScriptInput, signal?: AbortSignal) =>
      request(`${path(id)}/script`, workflowResponseSchema, json('PATCH', input), signal),
    updateScenes: (id: string, input: UpdateWorkflowScenesInput, signal?: AbortSignal) =>
      request(`${path(id)}/scenes`, workflowResponseSchema, json('PATCH', input), signal),
    upload: (id: string, expectedVersion: number, file: File, signal?: AbortSignal) =>
      request(
        `${path(id)}/assets?expectedVersion=${expectedVersion}`,
        workflowResponseSchema,
        {
          method: 'POST',
          headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
          body: file,
        },
        signal,
      ),
    describeAsset: (
      id: string,
      assetId: string,
      expectedVersion: number,
      description: string,
      signal?: AbortSignal,
    ) =>
      request(
        `${path(id)}/assets/${encodeURIComponent(assetId)}`,
        workflowResponseSchema,
        json('PATCH', { expectedVersion, description }),
        signal,
      ),
    removeAsset: (id: string, assetId: string, expectedVersion: number, signal?: AbortSignal) =>
      request(
        `${path(id)}/assets/${encodeURIComponent(assetId)}?expectedVersion=${expectedVersion}`,
        workflowResponseSchema,
        { method: 'DELETE' },
        signal,
      ),
    approveAll: (id: string, expectedVersion: number, signal?: AbortSignal) =>
      request(
        `${path(id)}/approve-all`,
        workflowResponseSchema,
        json('POST', { expectedVersion }),
        signal,
      ),
    async render(id: string, expectedVersion: number, signal?: AbortSignal) {
      return (
        await request(
          `${path(id)}/renders`,
          renderJobResponseSchema,
          json('POST', { expectedVersion }),
          signal,
        )
      ).job;
    },
    async getRender(id: string, jobId: string, signal?: AbortSignal) {
      return (
        await request(
          `${path(id)}/renders/${encodeURIComponent(jobId)}`,
          renderJobResponseSchema,
          {},
          signal,
        )
      ).job;
    },
    async getRenders(id: string, signal?: AbortSignal) {
      return (await request(`${path(id)}/renders`, renderJobsResponseSchema, {}, signal)).jobs;
    },
    getPublishKit: (id: string, signal?: AbortSignal) =>
      request(`${path(id)}/publish`, { parse: parsePublishKit }, {}, signal),
    assetUrl: (id: string, assetId: string) =>
      `${root}${path(id)}/assets/${encodeURIComponent(assetId)}`,
    videoUrl: (id: string, jobId: string, download = false) =>
      `${root}${path(id)}/renders/${encodeURIComponent(jobId)}/video${download ? '?download=1' : ''}`,
    async waitForRender(
      id: string,
      jobId: string,
      options: {
        signal?: AbortSignal;
        onUpdate?: (job: RenderJob) => void;
        timeoutMs?: number;
        intervalMs?: number;
      } = {},
    ): Promise<RenderJob> {
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.throwIfAborted();
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () =>
          controller.abort(
            new PromoApiError(
              'The render is still processing. Check its status again; starting another render could create a duplicate.',
              0,
              'RENDER_POLL_TIMEOUT',
            ),
          ),
        options.timeoutMs ?? 360_000,
      );
      try {
        while (true) {
          controller.signal.throwIfAborted();
          const job = await api.getRender(id, jobId, controller.signal);
          options.onUpdate?.(job);
          if (job.status === 'succeeded' || job.status === 'failed') return job;
          await new Promise<void>((resolve, reject) => {
            const stop = () => {
              clearTimeout(wait);
              reject(controller.signal.reason);
            };
            const wait = setTimeout(() => {
              controller.signal.removeEventListener('abort', stop);
              resolve();
            }, options.intervalMs ?? 1500);
            controller.signal.addEventListener('abort', stop, { once: true });
            if (controller.signal.aborted) stop();
          });
        }
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      }
    },
  };
  return api;
}

const apiOrigin = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? '';
export const promoApi = createPromoApi(apiOrigin);
