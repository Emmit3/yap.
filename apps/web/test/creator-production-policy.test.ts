import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { creatorJobSchema, type CreatorJob } from '@yap/contracts/creator';
import {
  productionDecision,
  readProductionRequest,
  saveProductionRequest,
} from '../src/creator/production.js';

const sessionId = randomUUID();
const approvalId = randomUUID();
const requestId = randomUUID();
const at = '2026-11-14T12:00:00.000Z';
function job(status: CreatorJob['status'], overrides: Partial<CreatorJob> = {}) {
  return creatorJobSchema.parse({
    id: randomUUID(),
    requestId,
    sessionId,
    approvalId,
    kind: 'production',
    status,
    phase: 'complete',
    sourceVersion: 2,
    workflowVersion: 3,
    clips: [],
    events: [],
    output: null,
    error: null,
    createdAt: at,
    updatedAt: at,
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

test('a pending request survives controller reload and stays scoped to its session and approval', () => {
  const store = storage();
  assert.equal(readProductionRequest(store, sessionId, approvalId), null);
  saveProductionRequest(store, sessionId, approvalId, requestId);
  assert.equal(readProductionRequest(store, sessionId, approvalId), requestId);
  assert.equal(readProductionRequest(store, randomUUID(), approvalId), null);
  assert.equal(readProductionRequest(store, sessionId, randomUUID()), null);
});

test('unreadable, malformed, or mismatched saved keys fail closed before paid submission', () => {
  const store = storage();
  saveProductionRequest(store, sessionId, approvalId, requestId);
  const key = [...store.values.keys()][0];
  for (const value of [
    'invalid JSON',
    'null',
    '[]',
    JSON.stringify({ version: 1, sessionId, approvalId, requestId: 'bad' }),
    JSON.stringify({ version: 1, sessionId: randomUUID(), approvalId, requestId }),
  ]) {
    store.setItem(key, value);
    assert.throws(
      () => readProductionRequest(store, sessionId, approvalId),
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
    () => readProductionRequest(unavailable, sessionId, approvalId),
    /could not be read/,
  );
  assert.throws(
    () => saveProductionRequest(unavailable, sessionId, approvalId, requestId),
    /No paid request was submitted/,
  );
  assert.throws(
    () =>
      saveProductionRequest(
        { getItem: () => null, setItem: () => {} },
        sessionId,
        approvalId,
        requestId,
      ),
    /could not be saved safely/,
  );
});

test('existing active and successful jobs reconnect without another paid POST', () => {
  const running = job('running');
  assert.deepEqual(productionDecision([running], approvalId, requestId), {
    kind: 'reconnect',
    job: running,
  });
  const complete = job('succeeded');
  assert.deepEqual(productionDecision([complete], approvalId, null), {
    kind: 'reconnect',
    job: complete,
  });
  const otherApproval = job('running', { approvalId: randomUUID() });
  assert.deepEqual(productionDecision([otherApproval], approvalId, requestId), {
    kind: 'reconnect',
    job: otherApproval,
  });
});

test('unknown submission outcomes replay their original idempotency key after history reconciliation', () => {
  assert.deepEqual(productionDecision([], approvalId, requestId), { kind: 'submit', requestId });
  const oldFailure = job('failed', { requestId: randomUUID() });
  assert.deepEqual(productionDecision([oldFailure], approvalId, requestId, oldFailure.id), {
    kind: 'submit',
    requestId,
  });
  assert.deepEqual(productionDecision([], approvalId, null), { kind: 'submit', requestId: null });
});

test('a failed or canceled job needs an explicit retry of that known latest job', () => {
  for (const status of ['failed', 'canceled'] as const) {
    const failure = job(status);
    assert.deepEqual(productionDecision([failure], approvalId, requestId), {
      kind: 'reconnect',
      job: failure,
    });
    assert.deepEqual(productionDecision([failure], approvalId, requestId, failure.id), {
      kind: 'submit',
      requestId: null,
    });
    assert.deepEqual(productionDecision([failure], approvalId, requestId, randomUUID()), {
      kind: 'reconnect',
      job: failure,
    });
  }
});

test('a retry cannot select an older failed job or turn a completed approval into a new run', () => {
  const older = job('failed', { createdAt: '2026-11-14T11:00:00.000Z', requestId: randomUUID() });
  const latest = job('failed');
  assert.deepEqual(productionDecision([older, latest], approvalId, requestId, older.id), {
    kind: 'reconnect',
    job: latest,
  });
  const complete = job('succeeded');
  assert.deepEqual(productionDecision([complete], approvalId, requestId, complete.id), {
    kind: 'reconnect',
    job: complete,
  });
});
