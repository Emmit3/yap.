import { useEffect, useState } from 'react';
import { posterStylesResponseSchema, posterDesignResponseSchema } from '@yap/contracts/posters';

const origin = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const result = await fetch(`${origin}/api/posters${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!result.ok) {
    let message = 'Your design could not be saved. Please try again.';
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
  async styles(signal: AbortSignal) {
    return posterStylesResponseSchema.parse(await request('/styles', { signal }));
  },
  async createDesign(styleId: string, changes: string, styleSha256: string, signal: AbortSignal) {
    return posterDesignResponseSchema.parse(
      await request('/designs', {
        method: 'POST',
        body: JSON.stringify({ styleId, changes, styleSha256 }),
        signal,
      }),
    );
  },
  async getDesign(id: string, signal: AbortSignal) {
    return posterDesignResponseSchema.parse(
      await request(`/designs/${encodeURIComponent(id)}`, { signal }),
    );
  },
  imageUrl(path: string) {
    return `${origin}${path}`;
  },
};

/**
 * Whether this server has any poster styles installed. Style packs are local and absent from
 * fresh clones, so the Posters tab is offered only once the server reports at least one style.
 */
export function usePostersAvailable(enabled: boolean): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled || available) return;
    const controller = new AbortController();
    posterApi
      .styles(controller.signal)
      .then(({ styles }) => setAvailable(styles.length > 0))
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled, available]);
  return available;
}
