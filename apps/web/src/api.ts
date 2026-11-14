import {
  apiErrorSchema,
  projectResponseSchema,
  projectsResponseSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '@yap/contracts';

const origin = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiFailure extends Error {
  constructor(
    message: string,
    public readonly status = 0,
  ) {
    super(message);
  }
}

async function response(path: string, init?: RequestInit): Promise<Response> {
  let result: Response;
  try {
    result = await fetch(`${origin}/api${path}`, {
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiFailure(
      'Yap could not reach the server. Check that the API is running, then try again.',
    );
  }
  if (!result.ok) {
    let message = 'This change could not be completed. Please try again.';
    try {
      const error = apiErrorSchema.safeParse(await result.json());
      if (error.success)
        message = [
          error.data.error.message,
          ...(error.data.error.details?.map((item) => `${item.path}: ${item.message}`) ?? []),
        ].join(' ');
    } catch {
      /* A non JSON server response receives the fallback message. */
    }
    throw new ApiFailure(message, result.status);
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
    throw new ApiFailure(
      'The server returned an unexpected response. Check that the frontend and API use the same contract.',
    );
  }
}

export const api = {
  list: () => request('/projects', projectsResponseSchema),
  get: (id: string) => request(`/projects/${encodeURIComponent(id)}`, projectResponseSchema),
  create: (input: CreateProjectInput) =>
    request('/projects', projectResponseSchema, { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: UpdateProjectInput) =>
    request(`/projects/${encodeURIComponent(id)}`, projectResponseSchema, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  generate: (id: string) =>
    request(`/projects/${encodeURIComponent(id)}/generate`, projectResponseSchema, {
      method: 'POST',
    }),
  remove: (id: string) => response(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  async download(id: string, title: string, format: 'markdown' | 'json') {
    const result = await response(`/projects/${encodeURIComponent(id)}/export?format=${format}`);
    const blob = await result.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${
      title
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 90) || 'yap-project'
    }.${format === 'markdown' ? 'md' : 'json'}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
