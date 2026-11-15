import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  creatorClipSchema,
  creatorJobSchema,
  creatorPlanSchema,
  creatorUpdatePlanSchema,
} from '../dist/creator.js';

const clip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'An original product shot.',
  camera: 'Still.',
  lighting: 'Soft.',
};
const plan = {
  id: randomUUID(),
  workflowVersion: 1,
  scriptId: randomUUID(),
  sourceScenesId: randomUUID(),
  caption: '',
  clips: [clip],
  model: 'gen4.5',
  ratio: '720:1280',
  hasAudio: false,
  maxAttemptsPerClip: 2,
  maxGeneratedSeconds: 10,
  createdAt: new Date().toISOString(),
};

test('old plans and sparse patches retain omitted provider and output choices', () => {
  const old = creatorPlanSchema.parse(plan);
  assert.equal(Object.hasOwn(old, 'outputProfileId'), false);
  assert.equal(Object.hasOwn(old.clips[0], 'videoProfileId'), false);
  const patch = creatorUpdatePlanSchema.parse({
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    clips: [clip],
    caption: '',
  });
  assert.equal(Object.hasOwn(patch, 'outputProfileId'), false);
  assert.equal(Object.hasOwn(patch, 'brandSnapshot'), false);
});

test('new native profile, model and generated-frame selections are explicit and bounded', () => {
  const selected = creatorPlanSchema.parse({
    ...plan,
    model: 'gen4_turbo',
    ratio: '1280:720',
    outputProfileId: 'landscape-720',
    clips: [
      { ...clip, videoProfileId: 'runway-gen4turbo-landscape', storyboardFrameId: randomUUID() },
    ],
  });
  assert.equal(selected.outputProfileId, 'landscape-720');
  assert.equal(selected.clips[0].videoProfileId, 'runway-gen4turbo-landscape');
  assert.equal(
    creatorClipSchema.safeParse({ ...clip, videoProfileId: 'unpriced-provider' }).success,
    false,
  );
  assert.equal(
    creatorPlanSchema.safeParse({ ...plan, outputProfileId: 'native-4k' }).success,
    false,
  );
  assert.equal(creatorPlanSchema.safeParse({ ...plan, model: 'unpriced-model' }).success, false);
});

function job(output) {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    sessionId: randomUUID(),
    kind: 'production',
    status: 'succeeded',
    phase: 'complete',
    sourceVersion: 1,
    workflowVersion: 1,
    approvalId: randomUUID(),
    clips: [],
    events: [],
    output,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('delivery receipts retain historical dimensions and reject false native labels', () => {
  const receipt = {
    bytes: 1000,
    sha256: 'a'.repeat(64),
    duration: 5,
    width: 1080,
    height: 1920,
    hasAudio: false,
  };
  assert.equal(creatorJobSchema.safeParse(job(receipt)).success, true);
  assert.equal(
    creatorJobSchema.safeParse(
      job({
        ...receipt,
        width: 720,
        height: 1280,
        outputProfileId: 'portrait-720',
        resized: false,
      }),
    ).success,
    true,
  );
  assert.equal(
    creatorJobSchema.safeParse(
      job({
        ...receipt,
        width: 1280,
        height: 720,
        outputProfileId: 'landscape-720',
        resized: false,
      }),
    ).success,
    true,
  );
  assert.equal(
    creatorJobSchema.safeParse(job({ ...receipt, outputProfileId: 'portrait-720' })).success,
    false,
  );
  assert.equal(
    creatorJobSchema.safeParse(
      job({ ...receipt, outputProfileId: 'portrait-1080', resized: false }),
    ).success,
    false,
  );
  assert.equal(creatorJobSchema.safeParse(job({ ...receipt, width: 1, height: 1 })).success, false);
});
