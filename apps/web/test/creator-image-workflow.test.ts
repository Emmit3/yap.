import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  creatorImageJobSchema,
  creatorImageQuoteSchema,
  creatorImageSettingsSchema,
  creatorImageVariantSchema,
  type CreatorImageLibrary,
} from '@yap/contracts/creator-images';
import { workflowImageAssetSchema } from '@yap/contracts/workflow';
import {
  clearKnownImageRequest,
  clearRejectedImageRequest,
  imageQuoteCurrent,
  imageSubmissionDecision,
  readImageRequest,
  saveImageRequest,
} from '../src/creator/image-workflow.js';

function fixture() {
  const at = '2026-11-14T12:00:00.000Z';
  const settings = creatorImageSettingsSchema.parse({
    prompt: 'A clean first frame of the product.',
    model: 'gpt-image-2.6-flare',
    quality: 'medium',
    size: '864x1536',
    complexity: 'low',
  });
  const quote = creatorImageQuoteSchema.parse({
    id: randomUUID(),
    sessionId: randomUUID(),
    sessionVersion: 3,
    workflowVersion: 5,
    settings,
    sourceSha256: null,
    maxCostCents: 200,
    currency: 'USD',
    createdAt: at,
    expiresAt: '2026-11-14T12:10:00.000Z',
    consumedByJobId: null,
  });
  const session = { id: quote.sessionId, version: 3, plan: null };
  const workflow = { version: 5, assets: [] };
  const library: CreatorImageLibrary = { configured: true, variants: [], jobs: [] };
  const job = creatorImageJobSchema.parse({
    id: randomUUID(),
    sessionId: session.id,
    requestId: randomUUID(),
    quoteId: quote.id,
    sourceVersion: 3,
    workflowVersion: 5,
    settings,
    status: 'running',
    reservationId: randomUUID(),
    maxCostCents: 200,
    submittedAt: at,
    variantId: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  });
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  return { settings, quote, session, workflow, library, job, storage, store, now: Date.parse(at) };
}

test('image cost approval binds exact model, prompt, quality, source, saved versions and expiry', () => {
  const { settings, quote, session, workflow, library, now } = fixture();
  assert.equal(imageQuoteCurrent(quote, session, workflow, settings, library, now), true);
  for (const changed of [
    { ...settings, prompt: 'A different scene' },
    { ...settings, model: 'gpt-image-2.6-sunburst' as const },
    { ...settings, quality: 'high' as const },
    { ...settings, sourceAssetId: randomUUID() },
    { ...settings, clipId: randomUUID() },
  ])
    assert.equal(imageQuoteCurrent(quote, session, workflow, changed, library, now), false);
  assert.equal(
    imageQuoteCurrent(quote, { ...session, version: 4 }, workflow, settings, library, now),
    false,
  );
  assert.equal(
    imageQuoteCurrent(quote, session, { ...workflow, version: 6 }, settings, library, now),
    false,
  );
  assert.equal(
    imageQuoteCurrent(quote, session, workflow, settings, library, Date.parse(quote.expiresAt)),
    false,
  );
  assert.equal(
    imageQuoteCurrent(
      { ...quote, consumedByJobId: randomUUID() },
      session,
      workflow,
      settings,
      library,
      now,
    ),
    false,
  );
});

test('an edit quote must still match the real bytes of its uploaded or generated reference', () => {
  const { settings, quote, session, library, now } = fixture();
  const media = workflowImageAssetSchema.parse({
    id: randomUUID(),
    filename: 'reference.png',
    mimeType: 'image/png',
    bytes: 200,
    width: 864,
    height: 1536,
    sha256: 'a'.repeat(64),
    description: 'Product',
    createdAt: quote.createdAt,
  });
  const workflow = { version: quote.workflowVersion, assets: [media] };
  const referenced = { ...settings, sourceAssetId: media.id };
  const quoted = { ...quote, settings: referenced, sourceSha256: media.sha256 };
  assert.equal(imageQuoteCurrent(quoted, session, workflow, referenced, library, now), true);
  assert.equal(
    imageQuoteCurrent(
      quoted,
      session,
      { ...workflow, assets: [{ ...media, sha256: 'b'.repeat(64) }] },
      referenced,
      library,
      now,
    ),
    false,
  );
  const variant = creatorImageVariantSchema.parse({
    id: randomUUID(),
    sessionId: session.id,
    jobId: randomUUID(),
    kind: 'generated',
    settings,
    sourceSha256: null,
    media,
    createdAt: quote.createdAt,
  });
  const edit = { ...settings, parentVariantId: variant.id };
  assert.equal(
    imageQuoteCurrent(
      { ...quote, settings: edit, sourceSha256: media.sha256 },
      session,
      workflow,
      edit,
      { ...library, variants: [variant] },
      now,
    ),
    true,
  );
  assert.equal(
    creatorImageSettingsSchema.safeParse({ ...edit, sourceAssetId: media.id }).success,
    false,
  );
});

test('paid image request identity survives reload and an unresolved request cannot be replaced', () => {
  const { quote, storage } = fixture();
  const record = { quote, requestId: randomUUID() };
  saveImageRequest(storage, record);
  assert.deepEqual(readImageRequest(storage, quote.sessionId), record);
  assert.throws(
    () =>
      saveImageRequest(storage, { quote: { ...quote, id: randomUUID() }, requestId: randomUUID() }),
    /could not be saved safely/,
  );
  assert.deepEqual(readImageRequest(storage, quote.sessionId), record);
  const broken = {
    ...storage,
    setItem: () => {
      throw new Error('disabled');
    },
  };
  assert.throws(() => saveImageRequest(broken, record), /No paid request|no new request/i);
});

test('known queued and terminal jobs reconnect without another paid POST; unknown outcomes keep the original ID', () => {
  const { quote, job } = fixture();
  const record = { quote, requestId: job.requestId };
  for (const status of ['queued', 'running', 'failed', 'canceled', 'succeeded'] as const)
    assert.equal(imageSubmissionDecision([{ ...job, status }], quote, record).kind, 'existing');
  assert.deepEqual(imageSubmissionDecision([], quote, record), {
    kind: 'submit',
    requestId: job.requestId,
  });
  assert.throws(
    () => imageSubmissionDecision([], { ...quote, id: randomUUID() }, record),
    /earlier image request/,
  );
  assert.throws(
    () => imageSubmissionDecision([], { ...quote, consumedByJobId: job.id }, null),
    /already used/,
  );
});

test('a local uncertain receipt clears only after the matching accepted server job is observed', () => {
  const { quote, job, storage } = fixture();
  const record = { quote, requestId: job.requestId };
  saveImageRequest(storage, record);
  assert.equal(clearKnownImageRequest(storage, record, []), false);
  assert.equal(
    clearKnownImageRequest(storage, record, [{ ...job, requestId: randomUUID() }]),
    false,
  );
  assert.ok(readImageRequest(storage, quote.sessionId));
  assert.equal(clearKnownImageRequest(storage, record, [job]), true);
  assert.equal(readImageRequest(storage, quote.sessionId), null);
});

test('a definite expired or stale rejection can clear only after fresh history confirms no accepted job', () => {
  const { quote, job, storage } = fixture();
  const record = { quote, requestId: job.requestId };
  saveImageRequest(storage, record);
  assert.equal(
    clearRejectedImageRequest(storage, record, [], { status: 0, code: 'NETWORK_ERROR' }),
    false,
  );
  assert.equal(
    clearRejectedImageRequest(storage, record, [], {
      status: 503,
      code: 'CREATOR_IMAGE_QUOTE_STALE',
    }),
    false,
  );
  assert.equal(
    clearRejectedImageRequest(storage, record, [], { status: 409, code: 'UNKNOWN_CONFLICT' }),
    false,
  );
  assert.equal(
    clearRejectedImageRequest(storage, record, [job], {
      status: 409,
      code: 'CREATOR_IMAGE_QUOTE_EXPIRED',
    }),
    false,
  );
  assert.ok(readImageRequest(storage, quote.sessionId));
  assert.equal(
    clearRejectedImageRequest(storage, record, [], {
      status: 409,
      code: 'CREATOR_IMAGE_QUOTE_EXPIRED',
    }),
    true,
  );
  assert.equal(readImageRequest(storage, quote.sessionId), null);
});

test('a late reconciliation for request A never deletes a newer request B stored by another tab', () => {
  const { quote, job, storage, store } = fixture();
  const old = { quote, requestId: job.requestId };
  const newer = { quote: { ...quote, id: randomUUID() }, requestId: randomUUID() };
  saveImageRequest(storage, old);
  const storageKey = [...store.keys()][0]!;
  storage.setItem(storageKey, JSON.stringify({ version: 1, ...newer }));
  assert.equal(clearKnownImageRequest(storage, old, [job]), false);
  assert.equal(
    clearRejectedImageRequest(storage, old, [], {
      status: 409,
      code: 'CREATOR_IMAGE_QUOTE_EXPIRED',
    }),
    false,
  );
  assert.deepEqual(readImageRequest(storage, quote.sessionId), newer);
});
