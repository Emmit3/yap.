import type { FilmReference } from '../creator/references';

/** Share pending/successful catalog reads; a failed read remains retryable by the next action. */
export function createReferenceCatalogReader(load: () => Promise<FilmReference[]>) {
  let cached: Promise<FilmReference[]> | undefined;
  return () => {
    if (cached) return cached;
    const pending = Promise.resolve().then(load);
    cached = pending;
    void pending.catch(() => {
      if (cached === pending) cached = undefined;
    });
    return pending;
  };
}
