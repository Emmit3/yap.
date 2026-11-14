import { apiErrorSchema } from '@yap/contracts';
import {
  creatorCapabilitiesSchema,
  creatorJobResponseSchema,
  creatorJobSchema,
  creatorSessionResponseSchema,
  creatorSessionSchema,
  creatorBudgetResponseSchema,
  creatorQuoteResponseSchema,
  type CreateCreatorSessionInput,
  type CreatorApproveInput,
  type CreatorJob,
  type CreatorPrepareInput,
  type CreatorProduceInput,
  type CreatorUpdatePlanInput,
  type PatchCreatorSessionInput,
} from '@yap/contracts/creator';

export class CreatorApiError extends Error {
  constructor(
    message: string,
    readonly code = 'REQUEST_FAILED',
    readonly status = 0,
  ) {
    super(message);
    this.name = 'CreatorApiError';
  }
}

const jobsSchema = {
  parse(value: unknown): { jobs: CreatorJob[] } {
    if (typeof value !== 'object' || value === null || !('jobs' in value)) {
      throw new Error('Missing creator jobs.');
    }
    return { jobs: creatorJobSchema.array().parse(value.jobs) };
  },
};

export const creatorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'This action could not be completed. Try again.';

export function createCreatorApi(origin = '', transport: typeof fetch = fetch) {
  const base = `${origin.replace(/\/$/, '')}/api/creator`;
  const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;
  const jobPath = (id: string, jobId: string) =>
    `${sessionPath(id)}/jobs/${encodeURIComponent(jobId)}`;
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new CreatorApiError(
            'The connection timed out. Reload the saved studio before retrying this action.',
            'REQUEST_TIMEOUT',
          ),
        ),
      90_000,
    );
    try {
      const response = await transport(`${base}${path}`, { ...init, signal: controller.signal });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = apiErrorSchema.safeParse(value);
        throw new CreatorApiError(
          error.success
            ? [
                error.data.error.message,
                ...(error.data.error.details ?? []).map(
                  (detail) => `${detail.path}: ${detail.message}`,
                ),
              ].join(' ')
            : `This request could not finish (${response.status}).`,
          error.success ? error.data.error.code : 'REQUEST_FAILED',
          response.status,
        );
      }
      try {
        return schema.parse(value);
      } catch {
        throw new CreatorApiError(
          'The saved response could not be read. Reload the studio and try again.',
          'INVALID_RESPONSE',
        );
      }
    } catch (error) {
      if (controller.signal.aborted)
        throw controller.signal.reason ?? new DOMException('Canceled', 'AbortError');
      if (error instanceof CreatorApiError) throw error;
      throw new CreatorApiError(
        'The studio could not reach the server. Check your connection and try again.',
        'NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  return {
    list: (signal?: AbortSignal) =>
      request(
        '/sessions',
        {
          parse(value: unknown) {
            if (typeof value !== 'object' || value === null || !('sessions' in value))
              throw new Error('Missing creator sessions.');
            return { sessions: creatorSessionSchema.array().parse(value.sessions) };
          },
        },
        {},
        signal,
      ),
    capabilities: (signal?: AbortSignal) =>
      request('/capabilities', creatorCapabilitiesSchema, {}, signal),
    budget: (signal?: AbortSignal) => request('/budget', creatorBudgetResponseSchema, {}, signal),
    create: (input: CreateCreatorSessionInput, signal?: AbortSignal) =>
      request('/sessions', creatorSessionResponseSchema, json('POST', input), signal),
    get: (id: string, signal?: AbortSignal) =>
      request(sessionPath(id), creatorSessionResponseSchema, {}, signal),
    patch: (id: string, input: PatchCreatorSessionInput, signal?: AbortSignal) =>
      request(sessionPath(id), creatorSessionResponseSchema, json('PATCH', input), signal),
    analyze: (id: string, expectedVersion: number, signal?: AbortSignal) =>
      request(
        `${sessionPath(id)}/analyze`,
        creatorJobResponseSchema,
        json('POST', { expectedVersion }),
        signal,
      ),
    jobs: (id: string, signal?: AbortSignal) =>
      request(`${sessionPath(id)}/jobs`, jobsSchema, {}, signal),
    job: (id: string, jobId: string, signal?: AbortSignal) =>
      request(jobPath(id, jobId), creatorJobResponseSchema, {}, signal),
    cancel: (id: string, jobId: string, signal?: AbortSignal) =>
      request(jobPath(id, jobId), creatorJobResponseSchema, { method: 'DELETE' }, signal),
    prepare: (id: string, input: CreatorPrepareInput, signal?: AbortSignal) =>
      request(
        `${sessionPath(id)}/prepare`,
        creatorSessionResponseSchema,
        json('POST', input),
        signal,
      ),
    savePlan: (id: string, input: CreatorUpdatePlanInput, signal?: AbortSignal) =>
      request(
        `${sessionPath(id)}/plan`,
        creatorSessionResponseSchema,
        json('PATCH', input),
        signal,
      ),
    quote: (id: string, input: CreatorPrepareInput, signal?: AbortSignal) =>
      request(`${sessionPath(id)}/quote`, creatorQuoteResponseSchema, json('POST', input), signal),
    approve: (id: string, input: CreatorApproveInput, signal?: AbortSignal) =>
      request(
        `${sessionPath(id)}/approve`,
        creatorSessionResponseSchema,
        json('POST', input),
        signal,
      ),
    produce: (id: string, input: CreatorProduceInput, signal?: AbortSignal) =>
      request(`${sessionPath(id)}/produce`, creatorJobResponseSchema, json('POST', input), signal),
    outputUrl: (id: string, jobId: string, download = false) =>
      `${base}${jobPath(id, jobId)}/video${download ? '?download=1' : ''}`,
    clipUrl: (id: string, jobId: string, clipId: string, attempt: number) =>
      `${base}${jobPath(id, jobId)}/clips/${encodeURIComponent(clipId)}/video?attempt=${attempt}`,
  };
}

export const creatorApi = createCreatorApi(
  (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? '',
);
