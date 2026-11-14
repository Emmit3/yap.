import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeFilmUrl,
  filmEmbedSource,
  filmPreviewSource,
  normalizeFilmCatalog,
  filterFilms,
  filmFilterOptions,
  readFilmShortlist,
  filmShortlistExport,
} from '../public/film-references-core.js';

const film = (id, changes = {}) => ({
  id,
  title: `Film ${id}`,
  brand: 'Studio brand',
  product: 'Speaker',
  creator: 'Maker',
  category: 'Audio',
  kind: 'campaign',
  url: `https://creator.example/work/${id}`,
  watchUrl: `https://vimeo.com/${id}`,
  techniques: ['Cloth simulation'],
  whyItFits: 'Curator inference: A tactile product reveal.',
  evidence: 'The creator describes its launch film.',
  videoEvidence: 'The case has a product-specific player.',
  featured: false,
  ...changes,
});
const normalize = (films) =>
  normalizeFilmCatalog({ generatedAt: '2026-11-14T10:00:00Z', films }).films;

test('untrusted records cannot turn watch or source links into executable destinations', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,test',
    'http://creator.example/film',
    '//creator.example/film',
    'https://user:password@creator.example/film',
  ]) {
    assert.equal(safeFilmUrl(url), null);
  }
  const films = normalize([
    film('safe', { title: '<img src=x onerror=alert(1)>', watchUrl: 'javascript:alert(1)' }),
    film('unsafe-source', { url: 'javascript:alert(1)' }),
  ]);
  assert.equal(films.length, 1);
  assert.equal(
    films[0].title,
    '<img src=x onerror=alert(1)>',
    'source text remains data for textContent',
  );
  assert.equal(films[0].watchUrl, films[0].url, 'the original HTTPS case is the safe fallback');
});

test('catalog counts include distinct film cases with video evidence, preserving unknown facts', () => {
  const result = normalizeFilmCatalog({
    films: [
      film('one', { year: null }),
      film('one'),
      film('variant', { url: 'https://creator.example/work/one#alternate' }),
      film('image-gallery', { videoEvidence: '' }),
      film('two', { techniques: null, kind: 'unverified' }),
      null,
    ],
  });
  assert.deepEqual(
    result.films.map((entry) => entry.id),
    ['one', 'two'],
  );
  assert.equal(result.omitted, 4);
  assert.equal(result.films[0].year, null);
  assert.equal(result.films[1].kind, 'unclear');
  assert.deepEqual(result.films[1].techniques, []);
  assert.throws(() => normalizeFilmCatalog({ films: [film('invalid', { url: 'data:test' })] }));
  assert.throws(() => normalizeFilmCatalog([]));
  assert.deepEqual(normalize([]), []);
});

test('search, category, creator, and highlights combine without losing the full catalog', () => {
  const films = normalize([
    film('one', { title: 'Café sound', creator: 'Tendril', featured: true }),
    film('two', { title: 'Café sound', creator: 'Other', featured: true }),
    film('three', { title: 'Café sound', creator: 'Tendril', category: 'Home', featured: true }),
    film('four', { title: 'Café sound', creator: 'Tendril' }),
  ]);
  const results = filterFilms(films, {
    query: 'CAFE cloth',
    category: 'Audio',
    creator: 'Tendril',
    featuredOnly: true,
  });
  assert.deepEqual(
    results.map((entry) => entry.id),
    ['one'],
  );
  assert.equal(filterFilms(films, { query: 'unknown' }).length, 0);
  assert.equal(films.length, 4);
  assert.deepEqual(
    filterFilms(films).map((entry) => entry.id),
    ['one', 'two', 'three', 'four'],
  );
});

test('filter options describe actual available sources and export ignores visible search filters', () => {
  const films = normalize([
    film('one'),
    film('two', { category: 'Gaming', creator: 'Another' }),
    film('three'),
  ]);
  assert.deepEqual(filmFilterOptions(films, 'category'), [
    { value: 'Audio', count: 2 },
    { value: 'Gaming', count: 1 },
  ]);
  assert.deepEqual(filmFilterOptions(films, 'unexpected'), []);
  const selected = readFilmShortlist('["two","one","missing","one",12]', films);
  assert.deepEqual([...selected], ['two', 'one']);
  assert.deepEqual([...readFilmShortlist('invalid-json', films)], []);
  assert.deepEqual([...readFilmShortlist('{"id":"one"}', films)], []);
  const exported = filmShortlistExport(films, selected, '2026-11-14T10:00:00Z');
  assert.deepEqual(
    exported.films.map((entry) => entry.id),
    ['one', 'two'],
  );
  assert.equal(exported.films[0].sourceUrl, 'https://creator.example/work/one');
  assert.equal(exported.films[0].watchUrl, 'https://vimeo.com/one');
  assert.equal(exported.exportedAt, '2026-11-14T10:00:00Z');
});

test('inline players use fixed provider hosts, muted playback and preserve Vimeo privacy hashes', () => {
  const youtube = filmEmbedSource('https://www.youtube.com/watch?v=dQw4w9WgXcQ&autoplay=0');
  const yt = new URL(youtube.src);
  assert.equal(yt.origin, 'https://www.youtube-nocookie.com');
  assert.equal(yt.searchParams.get('playlist'), 'dQw4w9WgXcQ');
  assert.equal(yt.searchParams.get('mute'), '1');
  assert.equal(yt.searchParams.get('controls'), '1');
  const vimeo = new URL(filmEmbedSource('https://vimeo.com/123456789/abcdef1234').src);
  assert.equal(vimeo.searchParams.get('h'), 'abcdef1234');
  assert.equal(vimeo.searchParams.get('muted'), '1');
  assert.equal(vimeo.searchParams.get('autopause'), '0');
  assert.equal(vimeo.searchParams.get('loop'), '1');
  const paused = new URL(
    filmEmbedSource('https://player.vimeo.com/video/123456789?h=abcdef1234', { autoplay: false })
      .src,
  );
  assert.equal(paused.searchParams.get('autoplay'), '0');
  assert.equal(paused.searchParams.get('loop'), '0');
  for (const url of [
    'https://vimeo.com.evil.example/123456789',
    'https://user:secret@vimeo.com/123456789',
    'https://player.vimeo.com:8443/video/123456789',
    'https://player.vimeo.com/video/123456789?h=invalid',
    'https://creator.example/work/film',
    'javascript:alert(1)',
  ])
    assert.equal(filmEmbedSource(url), null, url);
});

test('verified evidence supplies a player without guessing between different films', () => {
  const record = film('case', {
    watchUrl: 'https://creator.example/case',
    videoEvidence: 'The case-page player is https://player.vimeo.com/video/123456789?h=abcdef1234.',
  });
  const player = filmPreviewSource(record);
  assert.equal(new URL(player.src).searchParams.get('h'), 'abcdef1234');
  assert.equal(
    filmPreviewSource({
      ...record,
      videoEvidence: record.videoEvidence + ' Alternate https://vimeo.com/987654321',
    }),
    null,
  );
  assert.ok(
    filmPreviewSource({ ...record, previewUrl: 'https://vimeo.com/987654321' }).src.includes(
      '987654321',
    ),
  );
});

test('Mux streams use the documented iframe player and explicit creator files use native video', () => {
  const id = 'j1ppGEgL3KUlOWbx02UzLWDt7zL4M2QiI4KAJ4o700Y100';
  const mux = filmEmbedSource(`https://stream.mux.com/${id}.m3u8?redundant_streams=true`);
  assert.equal(mux.kind, 'iframe');
  assert.equal(new URL(mux.src).origin, 'https://player.mux.com');
  assert.equal(new URL(mux.src).searchParams.get('muted'), 'true');
  assert.equal(filmEmbedSource(`https://stream.mux.com/${id}/1080p.mp4`).kind, 'video');
  assert.equal(filmEmbedSource('https://panoply.co.uk/api/media/file/film.webm').kind, 'video');
  assert.equal(filmEmbedSource('https://evil.example/film.mp4'), null);
});
