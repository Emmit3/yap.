import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  REEL_ACTIONS_STORAGE_KEY,
  MAX_REEL_PREFERENCES,
  reelId,
  readReelPreferences,
  writeReelPreferences,
  toggleReelPreference,
  readSharedReelId,
  reelShareUrl,
  restoreSharedReel,
} from '../public/reel-actions.js';
import { wallLayout } from '../public/motion.js';

const reels = Array.from({ length: 77 }, (_, index) => ({
  sourceId: `mixkit:${index + 1}`,
  title: `Reference ${index + 1}`,
  poster: `https://yap.example/showcase/media/reference-${index + 1}.jpg`,
}));
function memoryStorage(raw = null) {
  const values = new Map(raw ? [[REEL_ACTIONS_STORAGE_KEY, raw]] : []);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('personal saved and liked state belongs to stable source IDs and survives reload independently', () => {
  const storage = memoryStorage();
  let state = readReelPreferences(storage, reels);
  state = toggleReelPreference(state, 'save', reelId(reels[0]), reels);
  state = toggleReelPreference(state, 'like', reelId(reels[1]), reels);
  assert.deepEqual(state, { saved: ['mixkit:1'], liked: ['mixkit:2'] });
  assert.equal(writeReelPreferences(storage, state, reels), true);
  const reordered = [reels[2], reels[1], reels[0]];
  assert.deepEqual(
    readReelPreferences(storage, reordered),
    state,
    'catalog position does not become identity',
  );
  state = toggleReelPreference(state, 'save', reelId(reels[0]), reels);
  assert.deepEqual(state, { saved: [], liked: ['mixkit:2'] });
  assert.deepEqual(toggleReelPreference(state, 'save', 'not-in-catalog', reels), state);
  assert.equal(
    reelId({ poster: 'https://yap.example/media/reference.jpg' }),
    reelId({ poster: 'https://yap.example/showcase/media/reference.jpg' }),
  );
  assert.equal(reelId({ sourceId: 42, poster: 'javascript:alert(1)' }), null);
});

test('unavailable, oversized, corrupt and stale browser storage cannot break personal actions', () => {
  const empty = { saved: [], liked: [] };
  for (const storage of [
    null,
    memoryStorage('{broken'),
    memoryStorage('x'.repeat(65537)),
    memoryStorage(JSON.stringify({ schemaVersion: 999, saved: ['mixkit:1'] })),
    {
      getItem() {
        throw new Error('blocked');
      },
    },
  ]) {
    assert.deepEqual(readReelPreferences(storage, reels), empty);
  }
  const storage = memoryStorage(
    JSON.stringify({
      schemaVersion: 1,
      saved: ['mixkit:1', 'mixkit:1', 'unknown', null],
      liked: ['mixkit:2'],
    }),
  );
  assert.deepEqual(readReelPreferences(storage, reels), {
    saved: ['mixkit:1'],
    liked: ['mixkit:2'],
  });
  const choices = toggleReelPreference(empty, 'save', 'mixkit:1', reels);
  assert.equal(
    writeReelPreferences(
      {
        setItem() {
          throw new Error('quota');
        },
      },
      choices,
      reels,
    ),
    false,
  );
  assert.deepEqual(choices.saved, ['mixkit:1'], 'in-memory choices survive failed persistence');
  const many = Array.from({ length: 200 }, (_, index) => ({ sourceId: `source:${index}` }));
  const oversized = memoryStorage(
    JSON.stringify({ schemaVersion: 1, saved: many.map(reelId), liked: [] }),
  );
  const bounded = readReelPreferences(oversized, many);
  assert.equal(bounded.saved.length, MAX_REEL_PREFERENCES);
  const toggled = toggleReelPreference(bounded, 'save', 'source:0', many);
  assert.equal(toggled.saved.length, MAX_REEL_PREFERENCES);
  assert.equal(toggled.saved.at(-1), 'source:0');
});

test('standalone and embedded links restore the exact reference without sharing iframe-only or foreign destinations', () => {
  const inner = 'https://yap.example/showcase/index.html?embedded=1&intro=1';
  const standalone = reelShareUrl(inner, 'mixkit:77');
  assert.equal(standalone, 'https://yap.example/showcase/index.html?reel=mixkit%3A77#reels');
  const outer = reelShareUrl(inner, 'mixkit:77', 'https://yap.example/?utm_source=old#/');
  assert.equal(outer, 'https://yap.example/?reel=mixkit%3A77#/');
  assert.equal(readSharedReelId(inner, outer), 'mixkit:77');
  assert.equal(readSharedReelId(standalone), 'mixkit:77');
  assert.equal(
    reelShareUrl(inner, 'mixkit:1', 'https://unrelated.example/'),
    'https://yap.example/showcase/index.html?reel=mixkit%3A1#reels',
  );
  assert.equal(readSharedReelId(inner, 'https://unrelated.example/?reel=mixkit%3A1'), null);
  assert.equal(reelShareUrl('javascript:alert(1)', 'mixkit:1'), null);
  assert.equal(reelShareUrl(inner, '\ninvalid'), null);
  assert.equal(readSharedReelId(inner + '?reel='), null);
});

test('links to the last catalog entry work on narrow and wide walls without changing media identity or repeating items', () => {
  const original = [...reels];
  const restored = restoreSharedReel(reels, 'mixkit:77');
  assert.equal(restored.index, 0);
  assert.equal(restored.reels[0], reels[76]);
  assert.equal(restored.reels.length, 77);
  assert.equal(new Set(restored.reels.map(reelId)).size, 77);
  assert.deepEqual(reels, original, 'restoring a link does not mutate the catalog');
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
    [3440, 1440],
  ]) {
    const count = wallLayout(width, height, restored.reels.length).count;
    assert.ok(restored.index < count);
    assert.equal(
      restored.reels.slice(0, count).filter((entry) => reelId(entry) === 'mixkit:77').length,
      1,
    );
  }
  assert.equal(restoreSharedReel(reels, 'missing').reels, reels);
  assert.deepEqual(restoreSharedReel([], 'mixkit:77'), { reels: [], index: -1 });
});

test('landing wiring refreshes per-reel controls and offers a labeled native copy fallback without changing catalog assets', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /from '\.\/reel-actions\.js'/);
  assert.match(app, /displayedReel = data;\s*updatePersonalActions\(data\)/);
  assert.match(app, /preferences = toggleReelPreference/);
  assert.match(app, /writeReelPreferences\(preferenceStorage, preferences, reels\)/);
  assert.match(app, /readSharedReelId\(location\.href, outerUrl\)/);
  assert.match(app, /window\.parent\.location\.href/);
  assert.match(app, /if \(!navigator\.clipboard\?\.writeText\)/);
  assert.match(app, /showShareLink\(url, reel\.title\)/);
  assert.match(app, /document\.createElement\('dialog'\)/);
  assert.match(app, /label\.htmlFor = 'share-link-url'/);
  assert.match(app, /field\.readOnly = true/);
  assert.match(app, /dialog\.showModal\(\)/);
  assert.match(app, /field\.select\(\)/);
  assert.match(app, /!shareDialog\?\.open/);
  assert.match(app, /#share-reel'\)\.focus/);
  const [builder, sync] = await Promise.all(
    ['../scripts/build-showcase.mjs', '../scripts/sync-showcase.mjs'].map((path) =>
      readFile(new URL(path, import.meta.url), 'utf8'),
    ),
  );
  assert.match(builder, /cp\(resolve\('public'\), output, \{ recursive: true \}\)/);
  assert.match(sync, /cp\(source, output, \{ recursive: true \}\)/);
});
