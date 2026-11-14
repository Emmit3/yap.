/** Resolve local showcase paths and retain each source image or film only once. */
export function uniqueReels(candidates, baseUrl) {
  if (!Array.isArray(candidates)) return [];
  const posters = new Set();
  const videos = new Set();
  const sources = new Set();
  const sourceIds = new Set();
  const resolve = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.startsWith('/media/') ? `.${value}` : value, baseUrl);
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  };
  const identity = (value) => (value ? value.split('?')[0] : null);
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.title !== 'string')
      return [];
    const poster = resolve(candidate.poster);
    const video = resolve(candidate.video);
    const source = resolve(candidate.sourceUrl);
    const sourceId = typeof candidate.sourceId === 'string' ? candidate.sourceId.trim() : '';
    if (
      !candidate.title.trim() ||
      !poster ||
      posters.has(identity(poster)) ||
      (video && videos.has(identity(video))) ||
      (source && sources.has(identity(source))) ||
      (sourceId && sourceIds.has(sourceId))
    )
      return [];
    posters.add(identity(poster));
    if (video) videos.add(identity(video));
    if (source) sources.add(identity(source));
    if (sourceId) sourceIds.add(sourceId);
    return [{ ...candidate, poster, video }];
  });
}

/** The wall, phone, counter, and full preview share the same bounded selection. */
export function reelSelection(reels, requested, limit = reels.length) {
  const capacity =
    limit === Infinity ? reels.length : Number.isFinite(limit) ? Math.floor(limit) : 0;
  const count = Math.max(0, Math.min(reels.length, capacity));
  const index = count
    ? Math.max(0, Math.min(count - 1, Number.isFinite(requested) ? Math.round(requested) : 0))
    : -1;
  return {
    index,
    count,
    reel: reels[index] ?? null,
    hasPrevious: index > 0,
    hasNext: index >= 0 && index < count - 1,
  };
}
