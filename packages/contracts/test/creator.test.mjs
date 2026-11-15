import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { creatorPlanSchema, creatorUpdatePlanSchema, creatorJobSchema } from '../dist/creator.js';
const clip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A cup.',
  camera: 'Still.',
  lighting: 'Soft.',
};
const plan = {
  id: randomUUID(),
  workflowVersion: 1,
  scriptId: randomUUID(),
  sourceScenesId: randomUUID(),
  caption: 'Social caption',
  clips: [clip],
  model: 'gen4.5',
  ratio: '720:1280',
  hasAudio: false,
  maxAttemptsPerClip: 2,
  maxGeneratedSeconds: 10,
  createdAt: new Date().toISOString(),
};
test('historical plans and sparse saves do not acquire subtitles', () => {
  const parsed = creatorPlanSchema.parse(plan);
  assert.equal(Object.hasOwn(parsed, 'subtitlesEnabled'), false);
  const patch = creatorUpdatePlanSchema.parse({
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    caption: plan.caption,
    clips: plan.clips,
  });
  assert.equal(Object.hasOwn(patch, 'subtitlesEnabled'), false);
  assert.equal(creatorPlanSchema.parse({ ...plan, subtitlesEnabled: true }).subtitlesEnabled, true);
  assert.equal(
    creatorPlanSchema.parse({ ...plan, subtitlesEnabled: false }).subtitlesEnabled,
    false,
  );
});
test('historical output remains without a fabricated subtitle receipt and new receipt is strict', () => {
  const output = {
    bytes: 123,
    sha256: 'a'.repeat(64),
    duration: 5,
    width: 1080,
    height: 1920,
    hasAudio: false,
  };
  const job = {
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
  assert.equal(Object.hasOwn(creatorJobSchema.parse(job).output, 'subtitles'), false);
  const subtitles = {
    format: 'srt',
    bytes: 200,
    sha256: 'b'.repeat(64),
    cueCount: 2,
    timingSource: 'narration',
  };
  assert.deepEqual(
    creatorJobSchema.parse({ ...job, output: { ...output, subtitles } }).output.subtitles,
    subtitles,
  );
  assert.equal(
    creatorJobSchema.safeParse({
      ...job,
      output: { ...output, subtitles: { ...subtitles, bytes: 128 * 1024 + 1 } },
    }).success,
    false,
  );
  assert.equal(
    creatorJobSchema.safeParse({
      ...job,
      output: { ...output, subtitles: { ...subtitles, path: 'private' } },
    }).success,
    false,
  );
});
