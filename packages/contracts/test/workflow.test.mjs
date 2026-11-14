import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approveWorkflowStageSchema,
  createWorkflowSchema,
  refineWorkflowSchema,
  updateWorkflowScriptSchema,
  workflowImageAssetSchema,
  workflowStageVerificationSchema,
} from '../dist/workflow.js';

test('workflow creation accepts a natural language starting point without inventing brief defaults', () => {
  assert.deepEqual(createWorkflowSchema.parse({ input: 'A video about my new backpack.' }), {
    input: 'A video about my new backpack.',
  });
  assert.equal(createWorkflowSchema.safeParse({ input: '   ' }).success, false);
  assert.equal(createWorkflowSchema.safeParse({ input: 'x'.repeat(8001) }).success, false);
});

test('refinement requires real changes, bounded answers, and an optimistic concurrency version', () => {
  for (const value of [
    { expectedVersion: 1 },
    { expectedVersion: 1, brief: {} },
    { expectedVersion: 1, answers: {} },
    { expectedVersion: 1, message: ' ' },
    { expectedVersion: 0, message: 'Make it warmer.' },
    { message: 'Make it warmer.' },
    { expectedVersion: 1, answers: { inventedField: 'Ignore the saved product.' } },
  ]) {
    assert.equal(refineWorkflowSchema.safeParse(value).success, false, JSON.stringify(value));
  }
  assert.deepEqual(refineWorkflowSchema.parse({ expectedVersion: 3, brief: { tone: 'bold' } }), {
    expectedVersion: 3,
    brief: { tone: 'bold' },
  });
  assert.deepEqual(
    refineWorkflowSchema.parse({
      expectedVersion: 3,
      answers: { imageDirection: 'Show the side pocket and keep the logo visible.' },
    }),
    {
      expectedVersion: 3,
      answers: { imageDirection: 'Show the side pocket and keep the logo visible.' },
    },
  );
});

test('script updates cannot overwrite server owned provenance or artifact identity', () => {
  const content = {
    expectedVersion: 4,
    hook: 'A pocket for the things you keep losing.',
    segments: [
      { id: '32801757-4a87-43b5-9b73-ad4499507a43', text: 'Meet the side pocket.', seconds: 15 },
    ],
    caption: 'A place for your everyday essentials.',
  };
  assert.equal(updateWorkflowScriptSchema.safeParse(content).success, true);
  for (const forged of [
    { provider: 'openai' },
    { id: '32801757-4a87-43b5-9b73-ad4499507a43' },
    { sourceRevision: 1 },
    { createdAt: '2026-11-13T12:00:00.000Z' },
  ]) {
    assert.equal(updateWorkflowScriptSchema.safeParse({ ...content, ...forged }).success, false);
  }
});

test('asset metadata has bounded image types and never accepts filesystem paths', () => {
  const asset = {
    id: '32801757-4a87-43b5-9b73-ad4499507a43',
    filename: 'product-front.png',
    mimeType: 'image/png',
    bytes: 1024,
    width: 100,
    height: 100,
    sha256: 'a'.repeat(64),
    description: 'Front of the backpack, supplied by the creator.',
    createdAt: '2026-11-13T12:00:00.000Z',
  };
  assert.equal(workflowImageAssetSchema.safeParse(asset).success, true);
  for (const invalid of [
    { filename: '../private.png' },
    { filename: 'C:\\private.png' },
    { mimeType: 'image/svg+xml' },
    { bytes: 10 * 1024 * 1024 + 1 },
    { path: '/private/image.png' },
  ]) {
    assert.equal(workflowImageAssetSchema.safeParse({ ...asset, ...invalid }).success, false);
  }
});

test('approval is explicit and verification does not represent automatic factual certainty', () => {
  assert.equal(
    approveWorkflowStageSchema.safeParse({ expectedVersion: 7, stage: 'script' }).success,
    true,
  );
  assert.equal(
    approveWorkflowStageSchema.safeParse({ expectedVersion: 7, stage: 'video' }).success,
    false,
  );
  const verification = { stage: 'brief', state: 'needs_review', checks: [], canApprove: true };
  assert.equal(workflowStageVerificationSchema.safeParse(verification).success, true);
  assert.equal(
    workflowStageVerificationSchema.safeParse({ ...verification, state: 'verified' }).success,
    false,
  );
});
