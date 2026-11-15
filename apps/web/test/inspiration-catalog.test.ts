import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseFilmCatalog } from '../src/creator/references';
import {
  filterProducts,
  loadProductInspiration,
  playableClip,
  productCategory,
  productInspiration,
} from '../src/inspiration/catalog';

const rawCatalog = JSON.parse(
  await readFile(new URL('../../../public/film-references.json', import.meta.url), 'utf8'),
);
const films = parseFilmCatalog(rawCatalog);
test('all catalog products stay browsable in practical business categories, including Adidas sportswear', () => {
  const products = productInspiration(films, null);
  assert.equal(products.length, 103);
  assert.equal(
    products.some((item) => item.category === 'other'),
    false,
  );
  const adidas = filterProducts(products, { query: 'Adidas', category: 'sportswear' });
  assert.ok(adidas.length >= 2);
  assert.ok(adidas.every((item) => item.film.brand.toLowerCase().includes('adidas')));
  assert.equal(filterProducts(products, { query: 'Adidas', category: 'food-drink' }).length, 0);
  assert.ok(filterProducts(products, { query: 'clothing adidas', category: 'all' }).length >= 2);
  assert.equal(productCategory({ category: 'Unknown new sector' }), 'other');
});

test('only supported public players and stable video files become inline clips', () => {
  assert.equal(
    playableClip('https://vimeo.com/123456789', 'https://creator.example.com/film')?.provider,
    'Vimeo',
  );
  const mux = playableClip(
    'https://player.mux.com/j1ppGEgL3KUlOWbx02UzLWDt7zL4M2QiI4KAJ4o700Y100?unused=1',
    'https://creator.example.com/film',
  );
  assert.equal(mux?.provider, 'Mux');
  assert.equal(mux?.src.includes('unused'), false);
  assert.equal(
    playableClip('https://cdn.example.com/public.mp4', 'https://creator.example.com/film')?.kind,
    'video',
  );
  for (const url of [
    'javascript:alert(1)',
    'http://cdn.example.com/a.mp4',
    'https://localhost/a.mp4',
    'https://127.0.0.1/a.mp4',
    'https://user:secret@cdn.example.com/a.mp4',
    'https://player.mux.com.evil.example/abc',
    'https://creator.example.com/case',
    'https://cdn.example.com/a.mp4?token=private',
  ])
    assert.equal(playableClip(url, 'https://creator.example.com/film'), null);
});

test('supplemental clips require a real catalog ID and attributed original source', () => {
  const first = films[0]!;
  const metadata = {
    schemaVersion: 1,
    clips: [
      {
        filmId: first.id,
        kind: 'embed',
        url: 'https://vimeo.com/123456789',
        sourceUrl: 'https://unrelated.example.com/case',
      },
      {
        filmId: 'invented',
        kind: 'embed',
        url: 'https://vimeo.com/123456789',
        sourceUrl: first.url,
      },
      {
        filmId: first.id,
        kind: 'embed',
        url: 'https://player.mux.com/j1ppGEgL3KUlOWbx02UzLWDt7zL4M2QiI4KAJ4o700Y100',
        posterUrl:
          'https://image.mux.com/j1ppGEgL3KUlOWbx02UzLWDt7zL4M2QiI4KAJ4o700Y100/thumbnail.webp',
        sourceUrl: first.url,
      },
    ],
  };
  const products = productInspiration(films, metadata);
  assert.equal(products.length, films.length);
  assert.equal(products[0]!.clip?.provider, 'Mux');
  assert.ok(products[0]!.clip?.poster?.startsWith('https://image.mux.com/'));
  assert.equal(products[0]!.film.url, first.url);
  assert.ok(products.filter((item) => item.clip !== null).length >= 47);
});

test('published media supplies real Adidas clips and suppresses known mismatched or unavailable media', async () => {
  const metadata = JSON.parse(
    await readFile(new URL('../../../public/inspiration-media.json', import.meta.url), 'utf8'),
  );
  const products = productInspiration(films, metadata);
  for (const id of ['adidas-ultraboost-21', 'adidas-originals-zx']) {
    const product = products.find((item) => item.film.id === id)!;
    assert.equal(product.category, 'sportswear');
    assert.equal(product.clip?.provider, 'Mux');
    assert.ok(product.clip?.poster?.startsWith('https://image.mux.com/'));
  }
  for (const id of ['onesal-tasty-cleaning', 'milia-matcha-tybann'])
    assert.equal(products.find((item) => item.film.id === id)!.clip, null);
  assert.ok(
    products
      .find((item) => item.film.id === 'ecobee-smarthome-futuredeluxe')!
      .clip?.src.includes('395076720'),
  );
  assert.equal(products.filter((item) => item.clip?.poster).length, metadata.clips.length);
  assert.equal(products.length, 103);
  assert.equal(products.filter((item) => item.clip).length, 90);
  assert.equal(products.filter((item) => item.clip?.provider === 'Mux').length, 19);
  for (const id of ['amazon-echo-buds', 'nuii-frantic-spec', 'sonos-move'])
    assert.equal(products.find((item) => item.film.id === id)!.clip?.provider, 'Mux');
});

test('attributed supplemental clips win over catalog previews and unavailable decisions win over both', () => {
  const film = films.find((item) => item.id === 'amazon-echo-buds')!;
  assert.ok(film.previewUrl && film.previewVerifiedAt);
  assert.equal(productInspiration([film], null)[0]!.clip?.provider, 'Mux');
  const metadata = {
    schemaVersion: 1,
    clips: [
      { filmId: film.id, kind: 'embed', sourceUrl: film.url, url: 'https://vimeo.com/123456789' },
    ],
    unavailable: [] as Array<{ filmId: string; sourceUrl: string }>,
  };
  assert.equal(productInspiration([film], metadata)[0]!.clip?.provider, 'Vimeo');
  assert.equal(
    productInspiration([film], {
      ...metadata,
      unavailable: [{ filmId: film.id, sourceUrl: 'https://unrelated.example.com/case' }],
    })[0]!.clip?.provider,
    'Vimeo',
    'another source cannot suppress this film',
  );
  metadata.unavailable.push({ filmId: film.id, sourceUrl: film.url });
  assert.equal(productInspiration([film], metadata)[0]!.clip, null);
});

test('the real loader combines explicit previews with source metadata using one catalog request', async (context) => {
  const metadata = JSON.parse(
    await readFile(new URL('../../../public/inspiration-media.json', import.meta.url), 'utf8'),
  );
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === '/showcase/film-references.json') return Response.json(rawCatalog);
    if (url === '/showcase/inspiration-media.json') return Response.json(metadata);
    throw new Error(`Unexpected catalog request: ${url}`);
  });
  const products = await loadProductInspiration(new AbortController().signal);
  assert.equal(products.length, 103);
  assert.equal(products.filter((item) => item.clip).length, 90);
  assert.equal(products.find((item) => item.film.id === 'amazon-echo-buds')!.clip?.provider, 'Mux');
  assert.equal(products.find((item) => item.film.id === 'onesal-tasty-cleaning')!.clip, null);
  assert.deepEqual(requests.sort(), [
    '/showcase/film-references.json',
    '/showcase/inspiration-media.json',
  ]);
});
