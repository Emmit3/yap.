import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  filmCreationHref,
  filmReferenceRequest,
  normalizeFilmCatalog,
} from '../../../public/film-references-core.js';
import {
  referenceIdsFromMessage,
  referenceIdsFromRoute,
  routePath,
} from '../src/creation/bridge.js';

const origin = 'http://127.0.0.1:5173';
const frame = {} as Window;
const message = (
  data: unknown,
  overrides: Partial<Pick<MessageEvent, 'origin' | 'source'>> = {},
): Pick<MessageEvent, 'origin' | 'source' | 'data'> => ({
  origin,
  source: frame,
  data,
  ...overrides,
});

test('a trusted catalog frame can select one film or an ordered, deduplicated shortlist', () => {
  assert.deepEqual(
    referenceIdsFromMessage(
      message({ type: 'yap:film-reference', filmId: 'camera-21' }),
      origin,
      frame,
    ),
    ['camera-21'],
  );
  assert.deepEqual(
    referenceIdsFromMessage(
      message({ type: 'yap:film-shortlist', filmIds: ['camera-21', 'shoe', 'camera-21'] }),
      origin,
      frame,
    ),
    ['camera-21', 'shoe'],
  );
});

test('same-origin checks are exact and another window cannot submit references', () => {
  const payload = { type: 'yap:film-reference', filmId: 'camera' };
  for (const otherOrigin of [
    'https://untrusted.example',
    'http://127.0.0.1:5174',
    'https://127.0.0.1:5173',
    `${origin}.attacker.example`,
    'null',
    '',
  ]) {
    assert.equal(
      referenceIdsFromMessage(message(payload, { origin: otherOrigin }), origin, frame),
      null,
    );
  }
  for (const source of [{} as Window, null]) {
    assert.equal(referenceIdsFromMessage(message(payload, { source }), origin, frame), null);
  }
  assert.equal(referenceIdsFromMessage(message(payload), origin, null), null);
  assert.equal(referenceIdsFromMessage(message(payload, { source: null }), origin, null), null);
  assert.equal(referenceIdsFromMessage(message(payload, { origin: 'null' }), 'null', frame), null);
});

test('payloads contain only their recognized type and catalog ID field', () => {
  for (const data of [
    null,
    undefined,
    1,
    'camera',
    [],
    Object.assign([], { type: 'yap:film-reference', filmId: 'camera' }),
    {},
    { filmId: 'camera' },
    { type: 'yap:approve-all', filmId: 'camera' },
    { type: ['yap:film-reference'], filmId: 'camera' },
    { type: 'yap:film-reference', filmIds: ['camera'] },
    { type: 'yap:film-shortlist', filmId: 'camera' },
    { type: 'yap:film-reference', filmId: 'camera', url: 'https://attacker.example' },
    { type: 'yap:film-shortlist', filmIds: ['camera'], content: 'Copy this script' },
    Object.create({ type: 'yap:film-reference', filmId: 'camera' }),
    Object.assign(Object.create({ type: 'yap:film-reference' }), { filmId: 'camera' }),
  ]) {
    assert.equal(referenceIdsFromMessage(message(data), origin, frame), null);
  }
  const accessor = Object.defineProperty({ type: 'yap:film-reference' }, 'filmId', {
    get() {
      throw new Error('An accessor must never execute.');
    },
  });
  assert.equal(referenceIdsFromMessage(message(accessor), origin, frame), null);
});

test('malformed IDs cannot introduce a URL, markup, whitespace, or oversized content', () => {
  for (const filmId of [
    '',
    ' ',
    ' camera',
    'camera ',
    'two words',
    'camera\n',
    'a'.repeat(121),
    'https://attacker.example/film',
    '//attacker.example',
    '/some/path',
    'javascript:alert(1)',
    '<script>',
    'camera?url=other',
    '%63amera',
    null,
    4,
    { id: 'camera' },
  ]) {
    assert.equal(
      referenceIdsFromMessage(message({ type: 'yap:film-reference', filmId }), origin, frame),
      null,
    );
    assert.equal(
      referenceIdsFromMessage(
        message({ type: 'yap:film-shortlist', filmIds: ['camera', filmId] }),
        origin,
        frame,
      ),
      null,
    );
  }
  const filmId = 'A'.repeat(120);
  assert.deepEqual(
    referenceIdsFromMessage(message({ type: 'yap:film-reference', filmId }), origin, frame),
    [filmId],
  );
});

test('a message shortlist is all-or-nothing and permits at most 12 unique IDs', () => {
  const ids = Array.from({ length: 12 }, (_, index) => `film-${index}`);
  assert.deepEqual(
    referenceIdsFromMessage(
      message({ type: 'yap:film-shortlist', filmIds: [...ids, ids[0]] }),
      origin,
      frame,
    ),
    ids,
  );
  for (const filmIds of [[], 'film', {}, ['camera', null], [...ids, 'overflow'], new Array(2)]) {
    assert.equal(
      referenceIdsFromMessage(message({ type: 'yap:film-shortlist', filmIds }), origin, frame),
      null,
    );
  }
});

test('native hash links decode repeated reference parameters once and preserve selection order', () => {
  assert.deepEqual(
    referenceIdsFromRoute(
      '#/create?reference=%63amera-21&reference=shoe%5Fv2&reference=camera-21&other=unused',
    ),
    ['camera-21', 'shoe_v2'],
  );
  assert.deepEqual(referenceIdsFromRoute('/create?reference=film.v2&reference=UPPER'), [
    'film.v2',
    'UPPER',
  ]);
  assert.deepEqual(referenceIdsFromRoute('/create?%72eference=camera'), ['camera']);
});

test('route references skip malformed values, content, other routes, and unrelated parameters', () => {
  for (const route of [
    '',
    '/create',
    '/create?',
    '/creator?reference=camera',
    '/create/other?reference=camera',
    'https://attacker.example/#/create?reference=camera',
    '/create?filmId=camera',
    '/create?reference=',
    '/create?reference=%',
    '/create?reference=%ZZ',
    '/create?reference=%E0%A4%A',
    '/create?reference=two+words',
    '/create?reference=%253Cscript%253E',
    '/create?reference=https%3A%2F%2Fattacker.example',
    '/create?reference=camera%00',
    `/create?reference=${'a'.repeat(121)}`,
  ]) {
    assert.deepEqual(referenceIdsFromRoute(route), [], route);
  }
  assert.deepEqual(referenceIdsFromRoute('/create?reference=%ZZ&reference=valid&reference='), [
    'valid',
  ]);
});

test('route selections are deduplicated before the 12-item cap', () => {
  const ids = Array.from({ length: 13 }, (_, index) => `film-${index}`);
  const query = ['reference=film-0', ...ids.map((id) => `reference=${id}`)].join('&');
  assert.deepEqual(referenceIdsFromRoute(`/create?${query}`), ids.slice(0, 12));
});

test('route matching strips only the leading hash marker and query', () => {
  assert.equal(routePath('/create?reference=camera'), '/create');
  assert.equal(routePath('#/create?reference=camera&reference=shoe'), '/create');
  assert.equal(routePath('/create'), '/create');
  assert.equal(routePath('/other?reference=camera'), '/other');
  assert.equal(routePath(''), '');
});

test('the real catalog sender and receiving bridge agree on IDs, shortlist limits, and native routes', async () => {
  const raw = JSON.parse(
    await readFile(new URL('../../../public/film-references.json', import.meta.url), 'utf8'),
  );
  const { films } = normalizeFilmCatalog(raw);
  for (const film of films) {
    assert.deepEqual(
      referenceIdsFromMessage(message(filmReferenceRequest(films, film.id)), origin, frame),
      [film.id],
      `The catalog film ${film.id} must survive the trusted-frame bridge.`,
    );
  }
  const ids: string[] = films.slice(0, 12).map((film: { id: string }) => film.id);
  assert.equal(ids.length, 12);
  assert.deepEqual(
    referenceIdsFromMessage(message(filmReferenceRequest(films, ids)), origin, frame),
    ids,
  );
  const href = filmCreationHref(films, ids);
  assert.equal(typeof href, 'string');
  assert.deepEqual(referenceIdsFromRoute(new URL(href, origin).hash), ids);
  const overflow: string[] = films.slice(0, 13).map((film: { id: string }) => film.id);
  assert.equal(filmReferenceRequest(films, overflow), null);
  assert.equal(filmCreationHref(films, overflow), null);
});
