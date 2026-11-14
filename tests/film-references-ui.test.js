import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeFilmUrl,
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
