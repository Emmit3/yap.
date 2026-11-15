import { externalFilmEmbed, loadFilmCatalog, type FilmReference } from '../creator/references';

export type ProductCategoryId =
  | 'all'
  | 'sportswear'
  | 'food-drink'
  | 'beauty'
  | 'tech-audio'
  | 'home-lifestyle'
  | 'mobility'
  | 'business'
  | 'other';
export const productCategories: Array<{ id: ProductCategoryId; label: string }> = [
  { id: 'all', label: 'All products' },
  { id: 'sportswear', label: 'Clothing & sportswear' },
  { id: 'food-drink', label: 'Food & drink' },
  { id: 'beauty', label: 'Beauty & personal care' },
  { id: 'tech-audio', label: 'Tech & audio' },
  { id: 'home-lifestyle', label: 'Lifestyle & home' },
  { id: 'mobility', label: 'Sport & mobility' },
  { id: 'business', label: 'Business & industry' },
  { id: 'other', label: 'Other products' },
];
export type ClipPreview = {
  kind: 'embed' | 'video';
  src: string;
  poster?: string;
  provider: string;
  sourceUrl: string;
};
export type InspirationProduct = {
  film: FilmReference;
  category: ProductCategoryId;
  clip: ClipPreview | null;
};

/** Product groupings are editorial navigation, derived from the catalog's stated product type. */
export function productCategory(film: Pick<FilmReference, 'category'>): ProductCategoryId {
  const category = film.category.toLowerCase();
  if (/aviation|industrial|sailing.*engineering/.test(category)) return 'business';
  if (/footwear|apparel|clothing|sportswear/.test(category)) return 'sportswear';
  if (/food|drinks?|spirits|coffee|matcha|tea\b/.test(category)) return 'food-drink';
  if (/beauty|skincare|fragrance|body care|personal.care/.test(category)) return 'beauty';
  if (
    /audio|speakers|computers?|electronics|gaming|mixed reality|networking|entertainment|smartphone/.test(
      category,
    )
  )
    return 'tech-audio';
  if (/automotive|motorsport|cycling|bmx|fitness/.test(category)) return 'mobility';
  if (/home|furniture|cleaning|luggage|jewelry|watches|toys|desk accessories/.test(category))
    return 'home-lifestyle';
  return 'other';
}

export function publicMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !host.includes('.') ||
      host.includes(':') ||
      /^\d+(?:\.\d+){3}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function playableClip(
  value: unknown,
  sourceUrl: string,
  poster?: unknown,
): ClipPreview | null {
  const safe = publicMediaUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  const embed = externalFilmEmbed(safe);
  const thumbnail = publicMediaUrl(poster) ?? undefined;
  if (embed) {
    const player = new URL(embed.src);
    player.searchParams.set('autoplay', '1');
    player.searchParams.set(embed.provider === 'YouTube' ? 'mute' : 'muted', '1');
    return {
      kind: 'embed',
      src: player.href,
      provider: embed.provider,
      sourceUrl,
      ...(thumbnail ? { poster: thumbnail } : {}),
    };
  }
  if (url.hostname === 'player.mux.com' && /^\/[A-Za-z0-9_-]{16,160}\/?$/.test(url.pathname)) {
    const player = new URL(url.pathname, 'https://player.mux.com');
    player.searchParams.set('autoplay', 'true');
    player.searchParams.set('muted', 'true');
    return {
      kind: 'embed',
      src: player.href,
      provider: 'Mux',
      sourceUrl,
      ...(thumbnail ? { poster: thumbnail } : {}),
    };
  }
  if (
    /\.(?:mp4|webm)$/i.test(url.pathname) &&
    ![...url.searchParams.keys()].some((key) =>
      /^(?:token|signature|expires|policy|key-pair-id|x-amz-.*)$/i.test(key),
    )
  ) {
    return {
      kind: 'video',
      src: safe,
      provider: 'Original source',
      sourceUrl,
      ...(thumbnail ? { poster: thumbnail } : {}),
    };
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null;
}
export function productInspiration(
  films: FilmReference[],
  metadata: unknown,
): InspirationProduct[] {
  const root = record(metadata);
  const entries =
    root?.schemaVersion === 1 && Array.isArray(root.clips) ? root.clips.slice(0, 300) : [];
  const byId = new Map(films.map((film) => [film.id, film]));
  const unavailable = new Set<string>();
  for (const entry of root?.schemaVersion === 1 && Array.isArray(root.unavailable)
    ? root.unavailable.slice(0, 300)
    : []) {
    const row = record(entry);
    if (!row || typeof row.filmId !== 'string') continue;
    const film = byId.get(row.filmId);
    if (film && publicMediaUrl(row.sourceUrl) === publicMediaUrl(film.url))
      unavailable.add(film.id);
  }
  const previews = new Map<string, ClipPreview>();
  for (const entry of entries) {
    const row = record(entry);
    if (!row || typeof row.filmId !== 'string' || previews.has(row.filmId)) continue;
    const film = byId.get(row.filmId);
    if (!film || (row.kind !== 'embed' && row.kind !== 'video')) continue;
    const source = publicMediaUrl(row.sourceUrl);
    if (!source || ![film.url, film.watchUrl].some((url) => publicMediaUrl(url) === source))
      continue;
    const clip = playableClip(row.url, source, row.posterUrl);
    if (clip && clip.kind === row.kind) previews.set(film.id, clip);
  }
  return films.map((film) => {
    const evidenceUrls = film.videoEvidence.match(/https:\/\/[^\s<>"']+/g) ?? [];
    const candidates = [
      film.watchUrl,
      ...evidenceUrls.slice(0, 8).map((url) => url.replace(/[),.;\]]+$/, '')),
    ];
    return {
      film,
      category: productCategory(film),
      clip: unavailable.has(film.id)
        ? null
        : (previews.get(film.id) ??
          candidates.map((url) => playableClip(url, film.url)).find((clip) => clip !== null) ??
          null),
    };
  });
}

const searchable = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
export function filterProducts(
  products: InspirationProduct[],
  filters: { query: string; category: ProductCategoryId },
): InspirationProduct[] {
  const words = searchable(filters.query.trim()).split(/\s+/).filter(Boolean);
  return products
    .filter(({ film, category }) => {
      if (filters.category !== 'all' && category !== filters.category) return false;
      const label = productCategories.find((item) => item.id === category)?.label ?? '';
      const text = searchable(
        [
          film.title,
          film.brand,
          film.product,
          film.category,
          film.creator,
          label,
          ...film.techniques,
        ].join(' '),
      );
      return words.every((word) => text.includes(word));
    })
    .sort((a, b) => Number(b.film.featured) - Number(a.film.featured));
}

export async function loadProductInspiration(signal: AbortSignal): Promise<InspirationProduct[]> {
  const extra = fetch('/showcase/inspiration-media.json', { signal })
    .then(async (response) => (response.ok ? response.json() : null))
    .catch((error: unknown) => {
      if (signal.aborted) throw error;
      return null;
    });
  const [films, metadata] = await Promise.all([loadFilmCatalog(signal), extra]);
  signal.throwIfAborted();
  return productInspiration(films, metadata);
}
