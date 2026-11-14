import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(
  await readFile(new URL('../public/film-references.json', import.meta.url), 'utf8'),
);
const canonical = (value) => {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`;
};

test('the catalogue contains a large set of distinct finished product films', () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(catalog.generatedAt)));
  assert.ok(catalog.films.length >= 100);
  assert.ok(new Set(catalog.films.map((film) => film.brand)).size >= 70);
  assert.equal(new Set(catalog.films.map((film) => film.id)).size, catalog.films.length);
  assert.equal(
    new Set(catalog.films.map((film) => canonical(film.url))).size,
    catalog.films.length,
  );
  assert.equal(
    new Set(catalog.films.map((film) => canonical(film.watchUrl))).size,
    catalog.films.length,
  );
  assert.ok(catalog.films.filter((film) => film.featured).length >= 10);
  assert.ok(catalog.films.some((film) => /matcha|whisk/i.test(`${film.title} ${film.product}`)));
});

test('every reference retains creator evidence and its external-reference boundary', () => {
  for (const film of catalog.films) {
    for (const key of [
      'id',
      'title',
      'brand',
      'product',
      'creator',
      'category',
      'whyItFits',
      'evidence',
      'videoEvidence',
    ])
      assert.ok(typeof film[key] === 'string' && film[key].trim().length > 0, `${film.id}: ${key}`);
    canonical(film.url);
    canonical(film.watchUrl);
    assert.ok(['campaign', 'spec', 'unclear'].includes(film.kind));
    assert.ok(['creator_case', 'video_page', 'direct_file'].includes(film.watchType));
    assert.ok(film.year === null || (Number.isInteger(film.year) && film.year >= 1990));
    assert.ok(Array.isArray(film.techniques));
    assert.ok(
      film.techniques.every((technique) => typeof technique === 'string' && technique.trim()),
    );
    assert.ok(Number.isFinite(Date.parse(film.verifiedAt)));
    assert.equal(film.usage, 'external_reference');
    assert.equal(film.rationaleIsEditorial, true);
    for (const url of film.additionalSources || []) canonical(url);
    assert.ok(
      !/mixkit\.co|images\.unsplash\.com/.test(film.url),
      'stock items do not count as finished product films',
    );
  }
});
