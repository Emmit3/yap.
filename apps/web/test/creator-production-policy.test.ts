import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { creatorJobSchema, type CreatorJob } from '@yap/contracts/creator';
import {
  productionDecision,
  readProductionRequest,
  saveProductionRequest,
} from '../src/creator/production.js';

const sessionId = randomUUID(),
  approvalId = randomUUID(),
  quoteId = randomUUID(),
  requestId = randomUUID();
function job(status: CreatorJob['status'], overrides: Partial<CreatorJob> = {}) {
  return creatorJobSchema.parse({
    id: randomUUID(),
    requestId,
    sessionId,
    approvalId,
    quoteId,
    kind: 'production',
    status,
    phase: 'complete',
    sourceVersion: 2,
    workflowVersion: 3,
    clips: [],
    events: [],
    output: null,
    error: null,
    createdAt: '2026-11-14T12:00:00.000Z',
    updatedAt: '2026-11-14T12:00:00.000Z',
    ...overrides,
  });
}
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test('pending request identity survives reload and is scoped to session, approval, and exact quote', () => {
  const store = storage();
  assert.equal(readProductionRequest(store, sessionId, approvalId, quoteId), null);
  saveProductionRequest(store, sessionId, approvalId, quoteId, requestId);
  assert.equal(readProductionRequest(store, sessionId, approvalId, quoteId), requestId);
  assert.equal(readProductionRequest(store, randomUUID(), approvalId, quoteId), null);
  assert.equal(readProductionRequest(store, sessionId, randomUUID(), quoteId), null);
  assert.equal(readProductionRequest(store, sessionId, approvalId, randomUUID()), null);
});

test('legacy, malformed, mismatched, and unavailable request storage fail before paid submission', () => {
  const store = storage();
  saveProductionRequest(store, sessionId, approvalId, quoteId, requestId);
  const key = [...store.values.keys()][0];
  for (const value of [
    'invalid JSON',
    'null',
    '[]',
    JSON.stringify({ version: 1, sessionId, approvalId, requestId }),
    JSON.stringify({ version: 2, sessionId, approvalId, quoteId: randomUUID(), requestId }),
    JSON.stringify({ version: 2, sessionId, approvalId, quoteId, requestId: 'bad' }),
  ]) {
    store.setItem(key, value);
    assert.throws(
      () => readProductionRequest(store, sessionId, approvalId, quoteId),
      /no new paid request was submitted/,
    );
  }
  const unavailable = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.throws(
    () => readProductionRequest(unavailable, sessionId, approvalId, quoteId),
    /could not be read/,
  );
  assert.throws(
    () => saveProductionRequest(unavailable, sessionId, approvalId, quoteId, requestId),
    /No paid request was submitted/,
  );
  assert.throws(
    () =>
      saveProductionRequest(
        { getItem: () => null, setItem() {} },
        sessionId,
        approvalId,
        quoteId,
        requestId,
      ),
    /could not be saved safely/,
  );
});

test('existing active or accepted work reconnects without another paid POST', () => {
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const) {
    const accepted = job(status);
    assert.deepEqual(productionDecision([accepted], approvalId, quoteId, requestId), {
      kind: 'reconnect',
      job: accepted,
    });
  }
  const other = job('running', { approvalId: randomUUID(), quoteId: randomUUID() });
  assert.deepEqual(productionDecision([other], approvalId, quoteId, requestId), {
    kind: 'reconnect',
    job: other,
  });
});

test('a mismatched browser key cannot resubmit a consumed failed or canceled quote', () => {
  for (const status of ['failed', 'canceled'] as const) {
    const accepted = job(status, { requestId: randomUUID() });
    assert.deepEqual(productionDecision([accepted], approvalId, quoteId, requestId), {
      kind: 'reconnect',
      job: accepted,
    });
  }
});

test('an unknown outcome reuses its original key only when the quote has no accepted server job', () => {
  assert.deepEqual(productionDecision([], approvalId, quoteId, requestId), {
    kind: 'submit',
    requestId,
  });
  assert.deepEqual(productionDecision([], approvalId, quoteId, null), {
    kind: 'submit',
    requestId: null,
  });
  const earlierQuote = job('failed', { quoteId: randomUUID(), requestId: randomUUID() });
  assert.deepEqual(productionDecision([earlierQuote], approvalId, quoteId, requestId), {
    kind: 'submit',
    requestId,
  });
});

test('a deliberately reviewed fresh quote cannot reuse another quote’s terminal job', () => {
  const failure = job('failed');
  const newQuote = randomUUID(),
    newApproval = randomUUID();
  assert.deepEqual(productionDecision([failure], newApproval, newQuote, null), {
    kind: 'submit',
    requestId: null,
  });
  const latest = job('failed', { createdAt: '2026-11-14T13:00:00.000Z' });
  assert.deepEqual(productionDecision([failure, latest], approvalId, quoteId, requestId), {
    kind: 'reconnect',
    job: latest,
  });
});
