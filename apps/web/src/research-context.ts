import { socialHandoffSchema, type SocialHandoff } from '@yap/contracts/social';

const key = 'yap.pending-research.v1';
type ContextStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function validateResearchContext(value: unknown): SocialHandoff {
  const context = socialHandoffSchema.parse(value);
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > 48 * 1024) {
    throw new Error(
      'This research selection is too large. Select fewer notes or insights and try again.',
    );
  }
  return context;
}

function contextStore(provided?: ContextStore | null): ContextStore | null {
  if (provided !== undefined) return provided;
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPendingResearch(store?: ContextStore | null): SocialHandoff | undefined {
  const storage = contextStore(store);
  try {
    const value = storage?.getItem(key);
    return value ? validateResearchContext(JSON.parse(value)) : undefined;
  } catch {
    try {
      storage?.removeItem(key);
    } catch {
      /* Storage may be unavailable. */
    }
    return undefined;
  }
}

export function savePendingResearch(
  value: SocialHandoff | undefined,
  store?: ContextStore | null,
): boolean {
  const storage = contextStore(store);
  if (!storage) return false;
  try {
    if (value) storage.setItem(key, JSON.stringify(validateResearchContext(value)));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
