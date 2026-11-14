import {
  posterContextResponseSchema,
  posterReferencesResponseSchema,
} from '@yap/contracts/posters';

const origin = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const result = await fetch(`${origin}/api/posters${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!result.ok) {
    let message = 'Poster references could not be loaded. Try again.';
    try {
      const body = await result.json();
      if (typeof body?.error?.message === 'string') message = body.error.message;
    } catch {
      /* Keep the readable fallback for non JSON failures. */
    }
    throw new Error(message);
  }
  return result.json();
}

export const posterApi = {
  async list(signal: AbortSignal) {
    return posterReferencesResponseSchema.parse(await request('/references', { signal }));
  },
  async context(prompt: string, referenceIds: string[], signal: AbortSignal) {
    return posterContextResponseSchema.parse(
      await request('/context', {
        method: 'POST',
        body: JSON.stringify({ prompt, referenceIds }),
        signal,
      }),
    );
  },
  imageUrl(path: string) {
    return `${origin}${path}`;
  },
};
