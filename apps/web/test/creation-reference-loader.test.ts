import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReferenceCatalogReader } from '../src/creation/reference-loader';
import { parseFilmCatalog } from '../src/creator/references';
import { readFile } from 'node:fs/promises';

const catalog = () =>
  readFile(new URL('../../../public/film-references.json', import.meta.url), 'utf8').then((json) =>
    parseFilmCatalog(JSON.parse(json)),
  );

test('a failed parent catalog request does not strand later reference selections', async () => {
  const films = await catalog();
  let calls = 0;
  const read = createReferenceCatalogReader(async () => {
    calls++;
    if (calls === 1) throw new Error('Temporary catalog failure');
    return films;
  });
  await assert.rejects(read(), /Temporary catalog failure/);
  const retried = await read();
  assert.equal(calls, 2);
  assert.equal(retried.length, 103);
  assert.ok(retried.some((film) => film.id === films[0]!.id));
  assert.equal(
    retried.some((film) => film.id === 'not-in-the-catalog'),
    false,
  );
  assert.equal(await read(), retried, 'successful reads remain shared');
  assert.equal(calls, 2);
});

test('concurrent actions share a pending validated catalog read', async () => {
  let calls = 0;
  const films = await catalog();
  let finish!: (value: typeof films) => void;
  const pending = new Promise<typeof films>((resolve) => {
    finish = resolve;
  });
  const read = createReferenceCatalogReader(() => {
    calls++;
    return pending;
  });
  const first = read();
  const second = read();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(films);
  assert.equal(await first, films);
  assert.equal(await second, films);
});
