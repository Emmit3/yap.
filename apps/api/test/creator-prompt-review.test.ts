import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CreatorPlan, CreatorClip } from '@yap/contracts/creator';
import { reviewCreatorPrompts } from '../src/creator-prompt-review.js';

function plan(change: Partial<CreatorClip> = {}): CreatorPlan {
  return {
    id: randomUUID(),
    workflowVersion: 1,
    scriptId: randomUUID(),
    sourceScenesId: randomUUID(),
    caption: '',
    model: 'seedance-v1.5-pro',
    provider: 'fal',
    ratio: '720:1280',
    hasAudio: false,
    maxAttemptsPerClip: 2,
    maxGeneratedSeconds: 10,
    createdAt: new Date().toISOString(),
    clips: [
      {
        id: randomUUID(),
        sceneId: randomUUID(),
        seconds: 5,
        assetId: randomUUID(),
        prompt: 'The supplied ceramic cup rests on a table.',
        camera: 'Slow push in.',
        lighting: 'Soft morning window light.',
        ...change,
      },
    ],
  };
}

test('preflight catches explicit conflicts before a paid render and keeps the exact submitted prompt', () => {
  const source = plan({
    prompt: 'Add readable text. A montage with music.',
    camera: 'Static camera, then orbit.',
  });
  const before = JSON.stringify(source);
  const review = reviewCreatorPrompts(source);
  assert.equal(review.planId, source.id);
  assert.deepEqual(
    review.clips[0]!.issues.map((issue) => issue.code),
    ['silent_output', 'added_text', 'continuous_shot', 'camera_conflict'],
  );
  assert.match(review.clips[0]!.compiledPrompt, /One continuous cinematic shot/);
  assert.equal(
    review.hasBlockingIssues,
    false,
    'heuristics are warnings, not automatic content rejection',
  );
  assert.equal(JSON.stringify(source), before, 'review cannot change the approved plan');
});

test('negative restrictions are not mistaken for requested sound, captions or cuts', () => {
  const review = reviewCreatorPrompts(
    plan({ prompt: 'Preserve the cup. No music. Do not add captions. Avoid jump cuts.' }),
  );
  assert.deepEqual(review.clips[0]!.issues, []);
});

test('stationary camera with a prohibition on zooming or panning is consistent', () => {
  for (const camera of ['Static camera, no zoom.', 'Locked-off camera; do not pan.'])
    assert.deepEqual(reviewCreatorPrompts(plan({ camera })).clips[0]!.issues, []);
});

test('the combined prompt limit includes camera, lighting and the provider suffix', () => {
  const review = reviewCreatorPrompts(plan({ prompt: 'A'.repeat(800), camera: 'B'.repeat(200) }));
  assert.equal(review.hasBlockingIssues, true);
  assert.equal(review.clips[0]!.issues[0]!.code, 'prompt_length');
});

test('an unanchored text shot receives guidance rather than an invented identity guarantee', () => {
  const source = plan();
  delete source.clips[0]!.assetId;
  const review = reviewCreatorPrompts(source);
  assert.equal(review.clips[0]!.issues[0]!.code, 'no_visual_anchor');
  assert.equal(review.hasBlockingIssues, false);
});
