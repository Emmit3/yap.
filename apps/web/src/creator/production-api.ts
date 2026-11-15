import { z } from 'zod';
import {
  brandSettingsSchema,
  brandSnapshotSchema,
  editDocumentSchema,
  editRenderReceiptSchema,
  editDraftSchema,
  type BrandInput,
  type EditDraft,
} from '@yap/contracts/production';
import { apiErrorSchema } from '@yap/contracts';

const brandResponse = z.object({ brand: brandSettingsSchema, snapshot: brandSnapshotSchema });
const editResponse = z.object({ edit: editDocumentSchema });
export function createProductionApi(origin = '', transport: typeof fetch = fetch) {
  const base = `${origin.replace(/\/$/u, '')}/api/creator`;
  const session = (id: string) => `/sessions/${encodeURIComponent(id)}/edits`;
  const edit = (sessionId: string, id: string) => `${session(sessionId)}/${encodeURIComponent(id)}`;
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
    const controller = new AbortController(),
      cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error('The local editor took too long. Reload its saved state before retrying.'),
        ),
      240_000,
    );
    try {
      const response = await transport(`${base}${path}`, { ...init, signal: controller.signal });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(value);
        throw new Error(
          parsed.success
            ? [
                parsed.data.error.message,
                ...(parsed.data.error.details ?? []).map((detail) => detail.message),
              ].join(' ')
            : `The editor request failed (${response.status}).`,
        );
      }
      return schema.parse(value);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    brand: (signal?: AbortSignal) => request('/brand', brandResponse, {}, signal),
    saveBrand: (expectedVersion: number, brand: BrandInput, signal?: AbortSignal) =>
      request('/brand', brandResponse, json('PATCH', { expectedVersion, brand }), signal),
    uploadLogo: (expectedVersion: number, file: File, signal?: AbortSignal) =>
      request(
        `/brand/logo?expectedVersion=${expectedVersion}`,
        brandResponse,
        { method: 'PUT', headers: { 'Content-Type': file.type }, body: file },
        signal,
      ),
    clearLogo: (expectedVersion: number, signal?: AbortSignal) =>
      request('/brand/logo', brandResponse, json('DELETE', { expectedVersion }), signal),
    logoUrl: (sha256: string) => `${base}/brand/logo/${encodeURIComponent(sha256)}.png`,
    list: (sessionId: string, signal?: AbortSignal) =>
      request(session(sessionId), z.object({ edits: z.array(editDocumentSchema) }), {}, signal),
    create: (sessionId: string, jobId: string, signal?: AbortSignal) =>
      request(session(sessionId), editResponse, json('POST', { jobId }), signal),
    get: (sessionId: string, id: string, signal?: AbortSignal) =>
      request(edit(sessionId, id), editResponse, {}, signal),
    save: (
      sessionId: string,
      id: string,
      expectedVersion: number,
      draft: EditDraft,
      signal?: AbortSignal,
    ) =>
      request(edit(sessionId, id), editResponse, json('PATCH', { expectedVersion, draft }), signal),
    history: (sessionId: string, id: string, signal?: AbortSignal) =>
      request(
        `${edit(sessionId, id)}/history`,
        z.object({
          history: z.array(
            z.object({ version: z.number().int(), draft: editDraftSchema, updatedAt: z.string() }),
          ),
        }),
        {},
        signal,
      ),
    render: (sessionId: string, id: string, expectedVersion: number, signal?: AbortSignal) =>
      request(
        `${edit(sessionId, id)}/render`,
        z.object({ render: editRenderReceiptSchema }),
        json('POST', { expectedVersion, reviewed: true }),
        signal,
      ),
    videoUrl: (sessionId: string, id: string, renderId: string, download = false) =>
      `${base}${edit(sessionId, id)}/renders/${encodeURIComponent(renderId)}/video${download ? '?download=1' : ''}`,
  };
}
export const productionApi = createProductionApi(
  (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? '',
);
