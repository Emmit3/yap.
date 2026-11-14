const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** External destinations must be absolute HTTPS URLs without embedded credentials. */
export function safeFilmUrl(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Keep valid, distinct case studies; an unsafe watch destination falls back to its source. */
export function normalizeFilmCatalog(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.films)) {
    throw new Error('The film list has an unexpected format. Please try again.');
  }
  const ids = new Set();
  const sources = new Set();
  const films = payload.films.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const id = text(entry.id);
    const title = text(entry.title);
    const brand = text(entry.brand);
    const creator = text(entry.creator);
    const category = text(entry.category);
    const url = safeFilmUrl(entry.url);
    const sourceIdentity = url?.split('#')[0];
    const videoEvidence = text(entry.videoEvidence);
    if (
      !id ||
      !title ||
      !brand ||
      !creator ||
      !category ||
      !url ||
      !videoEvidence ||
      ids.has(id) ||
      sources.has(sourceIdentity)
    )
      return [];
    ids.add(id);
    sources.add(sourceIdentity);
    return [
      {
        id,
        title,
        brand,
        creator,
        category,
        product: text(entry.product),
        kind: ['campaign', 'spec', 'unclear'].includes(entry.kind) ? entry.kind : 'unclear',
        url,
        watchUrl: safeFilmUrl(entry.watchUrl) ?? url,
        year:
          Number.isInteger(entry.year) && entry.year >= 1900 && entry.year <= 2200
            ? entry.year
            : null,
        techniques: Array.isArray(entry.techniques)
          ? entry.techniques.map(text).filter(Boolean)
          : [],
        whyItFits: text(entry.whyItFits).replace(/^Curator inference:\s*/i, ''),
        evidence: text(entry.evidence),
        videoEvidence,
        verifiedAt: text(entry.verifiedAt),
        featured: entry.featured === true,
      },
    ];
  });
  if (payload.films.length && !films.length) {
    throw new Error('The film list has no usable source links. Please try again.');
  }
  return {
    films,
    scope: text(payload.scope),
    generatedAt: text(payload.generatedAt),
    omitted: payload.films.length - films.length,
  };
}

const searchable = (value) =>
  value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export function filterFilms(
  films,
  { query = '', category = '', creator = '', featuredOnly = false } = {},
) {
  const words = searchable(query.trim()).split(/\s+/).filter(Boolean);
  return films
    .filter((film) => {
      if (category && film.category !== category) return false;
      if (creator && film.creator !== creator) return false;
      if (featuredOnly && !film.featured) return false;
      const haystack = searchable(
        [
          film.title,
          film.brand,
          film.product,
          film.creator,
          film.category,
          film.whyItFits,
          ...film.techniques,
        ].join(' '),
      );
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => Number(b.featured) - Number(a.featured));
}

export function filmFilterOptions(films, field) {
  if (!['category', 'creator'].includes(field)) return [];
  const counts = new Map();
  for (const film of films) counts.set(film[field], (counts.get(film[field]) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, count }));
}

export function readFilmShortlist(raw, films) {
  try {
    const values = JSON.parse(raw);
    if (!Array.isArray(values)) return new Set();
    const known = new Set(films.map((film) => film.id));
    return new Set(values.filter((id) => typeof id === 'string' && known.has(id)));
  } catch {
    return new Set();
  }
}

/** Exports retain the source and original watch destination alongside stable film IDs. */
export function filmShortlistExport(films, selectedIds, exportedAt = new Date().toISOString()) {
  return {
    exportedAt,
    films: films
      .filter((film) => selectedIds.has(film.id))
      .map((film) => ({
        id: film.id,
        title: film.title,
        brand: film.brand,
        creator: film.creator,
        sourceUrl: film.url,
        watchUrl: film.watchUrl,
      })),
  };
}
