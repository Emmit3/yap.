export const REEL_ACTIONS_STORAGE_KEY = 'yap.showcase.preferences.v1';
export const MAX_REEL_PREFERENCES = 128;
const validId = (value) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.trim() === value &&
  value.length <= 240 &&
  !/[\u0000-\u001f\u007f]/.test(value);

/** Prefer source identity; local fallback posters retain the same identity across hosting paths. */
export function reelId(reel) {
  if (typeof reel?.sourceId === 'string' && validId(reel.sourceId.trim()))
    return reel.sourceId.trim();
  try {
    const poster = new URL(reel?.poster);
    if (!['http:', 'https:', 'file:'].includes(poster.protocol)) return null;
    const name = poster.pathname.split('/').at(-1);
    return name && validId(`poster:${name}`) ? `poster:${name}` : null;
  } catch {
    return null;
  }
}

function normalizedPreferences(value, reels) {
  const known = new Set(reels.map(reelId).filter(Boolean));
  const clean = (items) =>
    Array.isArray(items)
      ? [...new Set(items.filter((id) => validId(id) && known.has(id)))].slice(
          -MAX_REEL_PREFERENCES,
        )
      : [];
  return { saved: clean(value?.saved), liked: clean(value?.liked) };
}

export function readReelPreferences(storage, reels) {
  try {
    const raw = storage?.getItem(REEL_ACTIONS_STORAGE_KEY);
    if (typeof raw !== 'string' || raw.length > 65536) return normalizedPreferences(null, reels);
    const value = JSON.parse(raw);
    return normalizedPreferences(value?.schemaVersion === 1 ? value : null, reels);
  } catch {
    return normalizedPreferences(null, reels);
  }
}

export function writeReelPreferences(storage, preferences, reels) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(
      REEL_ACTIONS_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, ...normalizedPreferences(preferences, reels) }),
    );
    return true;
  } catch {
    return false;
  }
}

export function toggleReelPreference(preferences, kind, id, reels) {
  const next = normalizedPreferences(preferences, reels);
  if (!['save', 'like'].includes(kind) || !reels.some((reel) => reelId(reel) === id)) return next;
  const field = kind === 'save' ? 'saved' : 'liked';
  next[field] = next[field].includes(id)
    ? next[field].filter((value) => value !== id)
    : [...next[field], id].slice(-MAX_REEL_PREFERENCES);
  return next;
}

function pageUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function outerPage(page, outerUrl) {
  const outer = pageUrl(outerUrl);
  return outer?.origin === page?.origin ? outer : null;
}

export function readSharedReelId(currentUrl, outerUrl) {
  const page = pageUrl(currentUrl);
  const outer = outerPage(page, outerUrl);
  const id = outer?.searchParams.get('reel') ?? page?.searchParams.get('reel');
  return validId(id) ? id : null;
}

export function reelShareUrl(currentUrl, id, outerUrl) {
  const page = pageUrl(currentUrl);
  if (!page || !validId(id)) return null;
  const outer = outerPage(page, outerUrl);
  const destination = outer ?? page;
  destination.search = '';
  destination.searchParams.set('reel', id);
  destination.hash = outer ? '/' : 'reels';
  return destination.href;
}

/** Keep a linked entry selectable even when a narrow wall displays only part of the catalog. */
export function restoreSharedReel(reels, id) {
  const index = id ? reels.findIndex((reel) => reelId(reel) === id) : -1;
  if (index < 0) return { reels, index: -1 };
  return { reels: [reels[index], ...reels.slice(0, index), ...reels.slice(index + 1)], index: 0 };
}
