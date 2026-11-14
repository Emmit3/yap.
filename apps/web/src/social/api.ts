import { apiErrorSchema } from '@yap/contracts';
import {
  socialHandoffSchema,
  socialInvestigationResponseSchema,
  socialInvestigationSummariesResponseSchema,
  socialProvidersResponseSchema,
  socialQueryResponseSchema,
  socialResearchRunResponseSchema,
  socialResearchCapabilitiesSchema,
  socialResearchArtifactResponseSchema,
  type SocialResearchRunInput,
  type SocialHandoffInput,
  type SocialDataset,
  type SocialNoteInput,
  type SocialNoteUpdate,
  type SocialResearchInput,
} from '@yap/contracts/social';

const origin = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ResearchApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

async function response(path: string, init?: RequestInit) {
  let result: Response;
  try {
    result = await fetch(`${origin}/api/social${path}`, {
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    });
  } catch {
    throw new Error(
      'Research could not reach the API. Check that the server is running and try again.',
    );
  }
  if (!result.ok) {
    let message = 'Research could not complete this request. Try again.';
    try {
      const parsed = apiErrorSchema.safeParse(await result.json());
      if (parsed.success) message = parsed.data.error.message;
    } catch {
      // A non JSON error response uses the safe fallback above.
    }
    throw new ResearchApiError(message, result.status);
  }
  return result;
}

async function request<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init?: RequestInit,
): Promise<T> {
  const result = await response(path, init);
  try {
    return schema.parse(await result.json());
  } catch {
    throw new Error(
      'The research response did not match the app contract. Update the frontend and API together.',
    );
  }
}

const mutation = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const investigationPath = (id: string) => `/investigations/${encodeURIComponent(id)}`;

export const socialApi = {
  researchCapabilities: () =>
    request('/research-runs/capabilities', socialResearchCapabilitiesSchema),
  startRun: (input: SocialResearchRunInput, signal?: AbortSignal) =>
    request('/research-runs', socialResearchRunResponseSchema, {
      ...mutation('POST', input),
      signal,
    }),
  getRun: (id: string, signal?: AbortSignal) =>
    request(`/research-runs/${encodeURIComponent(id)}`, socialResearchRunResponseSchema, {
      signal,
    }),
  cancelRun: (id: string) =>
    request(
      `/research-runs/${encodeURIComponent(id)}`,
      socialResearchRunResponseSchema,
      mutation('DELETE'),
    ),
  runArtifact: (id: string, path: string, signal?: AbortSignal) =>
    request(
      `/research-runs/${encodeURIComponent(id)}/artifacts?path=${encodeURIComponent(path)}`,
      socialResearchArtifactResponseSchema,
      { signal },
    ),
  providers: () => request('/providers', socialProvidersResponseSchema),
  list: () => request('/investigations?summary=true', socialInvestigationSummariesResponseSchema),
  get: (id: string, signal?: AbortSignal) =>
    request(investigationPath(id), socialInvestigationResponseSchema, { signal }),
  create: (input: SocialResearchInput) =>
    request('/investigations', socialInvestigationResponseSchema, mutation('POST', input)),
  importDataset: (input: SocialResearchInput, dataset: SocialDataset) =>
    request(
      '/investigations/import',
      socialInvestigationResponseSchema,
      mutation('POST', { input, dataset, publicDataOnly: true }),
    ),
  remove: (id: string) => response(investigationPath(id), mutation('DELETE')),
  query: (id: string, question: string) =>
    request(
      `${investigationPath(id)}/query`,
      socialQueryResponseSchema,
      mutation('POST', { question }),
    ),
  addNote: (id: string, input: SocialNoteInput) =>
    request(
      `${investigationPath(id)}/notes`,
      socialInvestigationResponseSchema,
      mutation('POST', input),
    ),
  updateNote: (id: string, noteId: string, input: SocialNoteUpdate) =>
    request(
      `${investigationPath(id)}/notes/${encodeURIComponent(noteId)}`,
      socialInvestigationResponseSchema,
      mutation('PATCH', input),
    ),
  removeNote: (id: string, noteId: string) =>
    request(
      `${investigationPath(id)}/notes/${encodeURIComponent(noteId)}`,
      socialInvestigationResponseSchema,
      mutation('DELETE'),
    ),
  handoff: (id: string, input: SocialHandoffInput) =>
    request(`${investigationPath(id)}/handoff`, socialHandoffSchema, mutation('POST', input)),
};

export function researchError(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'This research action could not be completed. Try again.';
}
