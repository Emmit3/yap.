import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  externalFilmEmbed,
  filmMatches,
  parseFilmCatalog,
  selectedFilm,
} from '../src/creator/references.js';

const record = {
  id: 'small-camera',
  title: 'See more',
  brand: 'OPKIX',
  product: 'Wearable camera',
  creator: 'Example studio',
  category: 'Technology',
  kind: 'campaign',
  url: 'https://example.com/case',
  watchUrl: 'https://vimeo.com/123456789',
  watchType: 'video_page',
  techniques: ['Macro scale', 'Match cuts'],
  whyItFits: 'An editorial suggestion about scale.',
  evidence: 'The creator identifies the product film.',
  videoEvidence: 'A playable film exists on the source page.',
  year: 2024,
  verifiedAt: '2026-11-14T12:00:00.000Z',
  featured: true,
  rationaleIsEditorial: true,
  usage: 'external_reference',
};

test('catalog parsing preserves product-specific search and deduplicates source IDs', () => {
  const films = parseFilmCatalog({
    schemaVersion: 1,
    films: [record, record, null, { ...record, id: 'bad', usage: 'owned_media' }],
  });
  assert.equal(films.length, 1);
  assert.equal(films[0].product, 'Wearable camera');
  assert.equal(filmMatches(films[0], ' Camera '), true);
  assert.equal(filmMatches(films[0], 'OPKIX', 'Technology'), true);
  assert.equal(filmMatches(films[0], 'camera', 'Fashion'), false);
  assert.equal(filmMatches(films[0], 'unrelated'), false);
});

test('malformed or unverified catalogs never become invented example cards', () => {
  assert.throws(() => parseFilmCatalog({ schemaVersion: 2, films: [record] }), /could not be read/);
  assert.throws(
    () =>
      parseFilmCatalog({ schemaVersion: 1, films: [{ ...record, rationaleIsEditorial: false }] }),
    /no readable/,
  );
  assert.throws(
    () =>
      parseFilmCatalog({
        schemaVersion: 1,
        films: [{ ...record, watchUrl: 'javascript:alert(1)' }],
      }),
    /no readable/,
  );
});

test('selections preserve attribution and only explicitly chosen catalog techniques', () => {
  const film = parseFilmCatalog({ schemaVersion: 1, films: [record] })[0];
  const selected = selectedFilm(film, ['Match cuts', 'Match cuts']);
  assert.deepEqual(selected.techniques, ['Match cuts']);
  assert.equal(selected.url, record.url);
  assert.equal(selected.watchUrl, record.watchUrl);
  assert.equal(selected.evidence, record.evidence);
  assert.equal(selected.usage, 'external_reference');
  assert.equal('product' in selected, false);
  assert.equal('video' in selected, false);
  assert.throws(() => selectedFilm(film, []), /Choose techniques/);
  assert.throws(() => selectedFilm(film, ['Unlisted effect']), /Choose techniques/);
});

test('all 103 catalog films pass the actual selection contract, including cited films with no technique tags', async () => {
  const payload = JSON.parse(
    await readFile(new URL('../../../public/film-references.json', import.meta.url), 'utf8'),
  );
  const films = parseFilmCatalog(payload);
  assert.equal(films.length, 103);
  for (const film of films) {
    const selection = selectedFilm(film, film.techniques);
    assert.equal(selection.id, film.id);
    assert.equal(selection.url, film.url);
    assert.equal(selection.watchUrl, film.watchUrl);
    assert.deepEqual(selection.techniques, film.techniques);
    assert.equal(selection.usage, 'external_reference');
  }
  for (const id of ['alani-witches-brew', 'apple-macbook-air-mvsm', 'mary-kay-timewise']) {
    const film = films.find((item) => item.id === id)!;
    assert.deepEqual(selectedFilm(film, []).techniques, []);
    assert.throws(() => selectedFilm(film, ['Invented technique']), /Choose techniques/);
  }
});

test('YouTube source URLs resolve only to a fixed privacy embed host without autoplay', () => {
  for (const value of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://youtube.com/embed/dQw4w9WgXcQ',
  ]) {
    assert.deepEqual(externalFilmEmbed(value), {
      provider: 'YouTube',
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
    });
  }
});

test('Vimeo source URLs resolve only to their fixed embed host', () => {
  assert.deepEqual(
    externalFilmEmbed(
      'https://player.vimeo.com/video/1238004406?h=2573484b0e&autoplay=0&title=0&portrait=0&byline=0&dnt=1',
    ),
    { provider: 'Vimeo', src: 'https://player.vimeo.com/video/1238004406?h=2573484b0e&dnt=1' },
  );
  for (const value of ['https://vimeo.com/123456789', 'https://player.vimeo.com/video/123456789']) {
    assert.deepEqual(externalFilmEmbed(value), {
      provider: 'Vimeo',
      src: 'https://player.vimeo.com/video/123456789?dnt=1',
    });
  }
});

test('case sites, downloads, lookalike hosts, credentials, and malformed IDs are never embedded', () => {
  for (const value of [
    'https://example.com/case',
    'https://example.com/film.mp4',
    'https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ',
    'https://youtube.com@attacker.example/watch?v=dQw4w9WgXcQ',
    'https://name:password@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com:8443/123456789',
    'http://vimeo.com/123456789',
    'https://youtube.com/watch?v=bad',
    'https://vimeo.com/channels/123456789',
    'https://player.vimeo.com/video/123456789?h=untrusted-value',
    'javascript:alert(1)',
    '',
  ])
    assert.equal(externalFilmEmbed(value), null, value);
});
