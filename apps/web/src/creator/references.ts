import {
  creatorExternalReferenceSchema,
  type CreatorExternalReference,
} from '@yap/contracts/creator';

export type FilmReference = CreatorExternalReference & {
  product: string;
  category: string;
  kind: 'campaign' | 'spec' | 'unclear';
  watchType: 'creator_case' | 'video_page' | 'direct_file';
  year: number | null;
  featured: boolean;
  videoEvidence: string;
};

export function parseFilmCatalog(value: unknown): FilmReference[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('films' in value) ||
    !Array.isArray(value.films)
  ) {
    throw new Error('The campaign catalog could not be read.');
  }
  const films: FilmReference[] = [];
  const seen = new Set<string>();
  for (const entry of value.films.slice(0, 600)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: Record<string, unknown> = entry;
    const parsed = creatorExternalReferenceSchema.safeParse({
      id: record.id,
      title: record.title,
      brand: record.brand,
      creator: record.creator,
      url: record.url,
      watchUrl: record.watchUrl,
      techniques: record.techniques,
      whyItFits: record.whyItFits,
      evidence: record.evidence,
      usage: record.usage,
      verifiedAt: record.verifiedAt,
    });
    if (!parsed.success || seen.has(parsed.data.id) || record.rationaleIsEditorial !== true)
      continue;
    if (
      !['campaign', 'spec', 'unclear'].includes(String(record.kind)) ||
      !['creator_case', 'video_page', 'direct_file'].includes(String(record.watchType))
    )
      continue;
    seen.add(parsed.data.id);
    films.push({
      ...parsed.data,
      product: typeof record.product === 'string' ? record.product : '',
      category: typeof record.category === 'string' ? record.category : 'Other',
      kind: record.kind as FilmReference['kind'],
      watchType: record.watchType as FilmReference['watchType'],
      year: typeof record.year === 'number' ? record.year : null,
      featured: record.featured === true,
      videoEvidence: typeof record.videoEvidence === 'string' ? record.videoEvidence : '',
    });
  }
  if (!films.length) throw new Error('The campaign catalog has no readable references.');
  return films;
}

export function filmMatches(film: FilmReference, query: string, category = 'all'): boolean {
  return (
    (category === 'all' || film.category === category) &&
    [film.title, film.brand, film.product, film.creator, ...film.techniques]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  );
}

export async function loadFilmCatalog(signal: AbortSignal): Promise<FilmReference[]> {
  const response = await fetch('/showcase/film-references.json', { signal });
  if (response.status === 404)
    throw new Error('Campaign catalog not available on this server yet.');
  if (!response.ok) throw new Error('The campaign catalog could not be loaded. Try again.');
  return parseFilmCatalog(await response.json());
}

export function selectedFilm(film: FilmReference, techniques: string[]): CreatorExternalReference {
  if (!techniques.length || techniques.some((technique) => !film.techniques.includes(technique))) {
    throw new Error('Choose techniques listed for this film.');
  }
  return creatorExternalReferenceSchema.parse({
    id: film.id,
    title: film.title,
    brand: film.brand,
    creator: film.creator,
    url: film.url,
    watchUrl: film.watchUrl,
    techniques: [...new Set(techniques)],
    whyItFits: film.whyItFits,
    evidence: film.evidence,
    usage: 'external_reference',
    verifiedAt: film.verifiedAt,
  });
}

/** Only known public video URL forms become fixed-host embeds after the user opens one. */
export function externalFilmEmbed(
  value: string,
): { src: string; provider: 'YouTube' | 'Vimeo' } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    let id: string | null = null;
    if (host === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
      id =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : (/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null);
    }
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id))
      return { src: `https://www.youtube-nocookie.com/embed/${id}?rel=0`, provider: 'YouTube' };
    if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) {
      const videoId = /^\/(?:video\/)?([0-9]{3,15})\/?$/.exec(url.pathname)?.[1];
      const hash = url.searchParams.get('h');
      if (hash && !/^[a-f0-9]{10}$/i.test(hash)) return null;
      if (videoId)
        return {
          src: `https://player.vimeo.com/video/${videoId}?${hash ? `h=${hash}&` : ''}dnt=1`,
          provider: 'Vimeo',
        };
    }
    return null;
  } catch {
    return null;
  }
}
