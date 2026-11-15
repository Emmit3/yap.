import { creatorSessionResponseSchema } from '@yap/contracts/creator';
import {
  creatorImageJobSchema,
  creatorImageQuoteSchema,
  referenceAnalysisSchema,
  type CreatorImageContext,
  type CreatorImageGenerate,
  type CreatorImageInput,
  type ReferenceAnalyze,
  type ReferenceImport,
} from '@yap/contracts/reference-assets';
import { CreatorApiError } from './api';

export function createReferenceAssetsApi(origin = '', transport: typeof fetch = fetch) {
  const base = `${origin.replace(/\/$/, '')}/api/creator`;
  const session = (id: string) => `/sessions/${encodeURIComponent(id)}`;
  const references = (id: string) => `${session(id)}/reference-analysis`;
  const reference = (id: string, referenceId: string) =>
    `${references(id)}/${encodeURIComponent(referenceId)}`;
  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  async function request<T>(
    path: string,
    parse: (value: unknown) => T,
    init: RequestInit = {},
    external?: AbortSignal,
  ): Promise<T> {
    const signal = external
      ? AbortSignal.any([external, AbortSignal.timeout(200_000)])
      : AbortSignal.timeout(200_000);
    const response = await transport(base + path, { ...init, signal, redirect: 'error' });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error =
        value && typeof value === 'object' && 'error' in value ? value.error : undefined;
      throw new CreatorApiError(
        error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
          ? error.message
          : 'The saved reference action could not be completed.',
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'REFERENCE_REQUEST_FAILED',
        response.status,
      );
    }
    return parse(value);
  }
  const property = (value: unknown, key: string) => {
    if (!value || typeof value !== 'object' || !(key in value))
      throw Error(`Missing ${key} response.`);
    return value[key as keyof typeof value];
  };
  return {
    async context(id: string, signal?: AbortSignal): Promise<CreatorImageContext> {
      const value = await request(
        session(id),
        (value) => creatorSessionResponseSchema.parse(value),
        {},
        signal,
      );
      return {
        sessionId: id,
        sessionVersion: value.session.version,
        workflowVersion: value.workflow.version,
      };
    },
    images: (id: string, signal?: AbortSignal) =>
      request(
        `${session(id)}/images`,
        (value) => ({
          images: creatorImageJobSchema.array().parse(property(value, 'images')),
          configured: property(value, 'configured') === true,
        }),
        {},
        signal,
      ),
    quoteImage: (context: CreatorImageContext, input: CreatorImageInput) =>
      request(
        `${session(context.sessionId)}/images/quote`,
        (value) => creatorImageQuoteSchema.parse(property(value, 'quote')),
        json('POST', {
          ...input,
          sessionVersion: context.sessionVersion,
          workflowVersion: context.workflowVersion,
        }),
      ),
    generateImage: (id: string, input: CreatorImageGenerate) =>
      request(
        `${session(id)}/images/generate`,
        (value) => creatorImageJobSchema.parse(property(value, 'image')),
        json('POST', input),
      ),
    imageUrl: (id: string, frameId: string) =>
      `${base}${session(id)}/images/${encodeURIComponent(frameId)}/image`,
    references: (id: string, signal?: AbortSignal) =>
      request(
        references(id),
        (value) => ({
          references: referenceAnalysisSchema.array().parse(property(value, 'references')),
          configured: property(value, 'configured') === true,
        }),
        {},
        signal,
      ),
    importReference: (id: string, input: ReferenceImport) =>
      request(
        references(id),
        (value) => referenceAnalysisSchema.parse(property(value, 'reference')),
        json('POST', input),
      ),
    addFrame: (id: string, referenceId: string, version: number, atSeconds: number, file: File) =>
      request(
        `${reference(id, referenceId)}/frames?expectedVersion=${version}&atSeconds=${encodeURIComponent(atSeconds)}`,
        (value) => referenceAnalysisSchema.parse(property(value, 'reference')),
        {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        },
      ),
    frameUrl: (id: string, referenceId: string, frameId: string) =>
      `${base}${reference(id, referenceId)}/frames/${encodeURIComponent(frameId)}/image`,
    addObservation: (
      id: string,
      referenceId: string,
      expectedVersion: number,
      text: string,
      atSeconds?: number,
    ) =>
      request(
        `${reference(id, referenceId)}/observations`,
        (value) => referenceAnalysisSchema.parse(property(value, 'reference')),
        json('POST', { expectedVersion, text, ...(atSeconds === undefined ? {} : { atSeconds }) }),
      ),
    analyze: (id: string, referenceId: string, input: ReferenceAnalyze) =>
      request(
        `${reference(id, referenceId)}/analyze`,
        (value) => referenceAnalysisSchema.parse(property(value, 'reference')),
        json('POST', input),
      ),
  };
}
export const referenceAssetsApi = createReferenceAssetsApi(
  (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? '',
);
