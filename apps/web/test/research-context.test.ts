import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readPendingResearch,
  savePendingResearch,
  validateResearchContext,
} from '../src/research-context.js';

function context() {
  return {
    investigationId: '11111111-1111-4111-8111-111111111111',
    topic: 'Neighborhood cafe films',
    audience: 'Local cafe visitors',
    creativeDirection: 'Use a close detail, then show the setting. This is creative context only.',
    selectedNoteIds: ['22222222-2222-4222-8222-222222222222'],
    selectedInsightIds: [],
    evidence: [
      {
        postId: 'post-1',
        url: 'https://example.com/cafe-film',
        excerpt: 'Close product detail before a wide frame.',
        collectedAt: '2026-11-13T12:00:00.000Z',
        publishedAt: '2026-11-10T12:00:00.000Z',
        provider: 'import',
        contentKind: 'post',
      },
    ],
    sourceUrls: ['https://example.com/cafe-film'],
    cautions: ['Observed engagement does not establish what will work for your business.'],
  };
}

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

test('pending creative context retains attribution, dates, and cautions across a reload', () => {
  const store = storage();
  const source = context();
  const validated = validateResearchContext(source);
  assert.equal(savePendingResearch(validated, store), true);
  assert.deepEqual(readPendingResearch(store), source);
  assert.equal(savePendingResearch(undefined, store), true);
  assert.equal(readPendingResearch(store), undefined);
});

test('invalid or oversized context cannot be mounted as creator facts', () => {
  assert.throws(() =>
    validateResearchContext({ ...context(), sourceUrls: ['javascript:alert(1)'] }),
  );
  assert.throws(
    () =>
      validateResearchContext({
        ...context(),
        creativeDirection: '🌱'.repeat(8000),
        cautions: Array.from({ length: 10 }, () => '🌱'.repeat(1000)),
      }),
    /too large/,
  );
});

test('corrupt or unavailable session storage does not break the workspace', () => {
  const store = storage();
  store.data.set('yap.pending-research.v1', '{bad json');
  assert.equal(readPendingResearch(store), undefined);
  assert.equal(store.data.size, 0);
  assert.equal(readPendingResearch(null), undefined);
  const denied = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(readPendingResearch(denied), undefined);
  assert.equal(savePendingResearch(validateResearchContext(context()), denied), false);
});
