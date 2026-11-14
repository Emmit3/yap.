import assert from 'node:assert/strict';
import test from 'node:test';
import { destinationForShowcaseMessage } from '../src/landing/messages.js';

const origin = 'http://127.0.0.1:5173';
const iframe = {};
const message = (data: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) => ({
  origin,
  source: iframe,
  data,
  ...overrides,
});

test('the showcase iframe can request the studio', () => {
  assert.equal(
    destinationForShowcaseMessage(message({ type: 'yap:enter-studio' }), origin, iframe),
    'studio',
  );
});

test('the showcase iframe can request social research', () => {
  assert.equal(
    destinationForShowcaseMessage(message({ type: 'yap:open-social' }), origin, iframe),
    'social',
  );
});

test('an iframe message must match the exact parent origin', () => {
  for (const otherOrigin of [
    'https://untrusted.example',
    'http://127.0.0.1:5174',
    'https://127.0.0.1:5173',
    `${origin}.untrusted.example`,
    'null',
  ]) {
    assert.equal(
      destinationForShowcaseMessage(
        message({ type: 'yap:enter-studio' }, { origin: otherOrigin }),
        origin,
        iframe,
      ),
      null,
    );
  }
});

test('another same-origin window cannot request navigation', () => {
  for (const otherSource of [{}, null, undefined]) {
    assert.equal(
      destinationForShowcaseMessage(
        message({ type: 'yap:open-social' }, { source: otherSource }),
        origin,
        iframe,
      ),
      null,
    );
  }
});

test('no navigation is accepted before an iframe source exists', () => {
  for (const missingSource of [null, undefined]) {
    assert.equal(
      destinationForShowcaseMessage(
        message({ type: 'yap:enter-studio' }, { source: missingSource }),
        origin,
        missingSource,
      ),
      null,
    );
  }
});

test('null, primitive, and array payloads are ignored', () => {
  const arrayWithType = Object.assign([], { type: 'yap:enter-studio' });
  for (const payload of [null, undefined, 'yap:enter-studio', 42, true, [], arrayWithType]) {
    assert.equal(destinationForShowcaseMessage(message(payload), origin, iframe), null);
  }
});

test('missing, malformed, nested, and unknown message types are ignored', () => {
  for (const payload of [
    {},
    { type: null },
    { type: 42 },
    { type: ['yap:enter-studio'] },
    { data: { type: 'yap:enter-studio' } },
    { type: 'yap:approve-all' },
    { type: 'yap:enter-studio/other' },
  ]) {
    assert.equal(destinationForShowcaseMessage(message(payload), origin, iframe), null);
  }
});

test('navigation types must be an own payload property', () => {
  const inherited = Object.create({ type: 'yap:enter-studio' });
  assert.equal(destinationForShowcaseMessage(message(inherited), origin, iframe), null);
});
