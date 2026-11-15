import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  creatorJobSchema,
  creatorPromptReviewSchema,
  creatorSessionSchema,
} from '@yap/contracts/creator';
import { workflowSchema } from '@yap/contracts/workflow';
import { planDraft } from '../src/creator/model.js';
import {
  promptReviewMatches,
  savedPromptContext,
  stageClipRevision,
} from '../src/creator/quality.js';

function fixture() {
  const at = '2026-11-14T12:00:00.000Z';
  const workflow = workflowSchema.parse({
    id: randomUUID(),
    version: 3,
    contentRevision: 1,
    title: 'Product film',
    input: 'A closer look.',
    brief: { productName: 'My product', audience: 'Local customers', callToAction: 'Visit us' },
    assets: [],
    messages: [],
    questions: [],
    script: {
      id: randomUUID(),
      sourceRevision: 1,
      hook: 'A closer look',
      segments: [{ id: randomUUID(), text: 'Made with care', seconds: 5 }],
      caption: '',
      provider: 'guided',
      createdAt: at,
    },
    scenes: {
      id: randomUUID(),
      sourceScriptId: randomUUID(),
      scenes: [
        {
          id: randomUUID(),
          scriptSegmentId: randomUUID(),
          seconds: 5,
          visual: 'Product detail',
          onScreenText: '',
          assetIds: [],
        },
      ],
      provider: 'guided',
      createdAt: at,
    },
    approvals: { brief: null, script: null, scenes: null },
    createdAt: at,
    updatedAt: at,
  });
  assert.ok(workflow.script && workflow.scenes);
  const clips = [0, 1].map(() => ({
    id: randomUUID(),
    sceneId: randomUUID(),
    seconds: 5,
    prompt: 'Keep the supplied product still.',
    camera: 'Slow push',
    lighting: 'Soft daylight',
    assetId: randomUUID(),
    referenceIds: ['reference-technique'],
  }));
  const session = creatorSessionSchema.parse({
    id: randomUUID(),
    version: 2,
    workflowId: workflow.id,
    input: { mode: 'media', prompt: 'A closer look.', urls: [] },
    answers: [],
    research: null,
    selectedReferenceIds: [],
    externalReferences: [],
    plan: {
      id: randomUUID(),
      workflowVersion: workflow.version,
      scriptId: workflow.script.id,
      sourceScenesId: workflow.scenes.id,
      caption: 'Original caption',
      clips,
      provider: 'fal',
      model: 'seedance-v1.5-pro',
      ratio: '720:1280',
      hasAudio: false,
      maxAttemptsPerClip: 2,
      maxGeneratedSeconds: 20,
      createdAt: at,
    },
    approval: null,
    createdAt: at,
    updatedAt: at,
  });
  assert.ok(session.plan);
  const revision = {
    prompt: 'Keep the original product shape and label unchanged.',
    camera: 'Locked camera, no zoom.',
    lighting: 'Steady soft daylight.',
    reason: 'The sampled label distorted during camera movement.',
  };
  const job = creatorJobSchema.parse({
    id: randomUUID(),
    requestId: randomUUID(),
    sessionId: session.id,
    kind: 'production',
    status: 'failed',
    phase: 'auditing',
    sourceVersion: session.version,
    workflowVersion: workflow.version,
    planId: session.plan.id,
    approvalId: randomUUID(),
    clips: [
      {
        clipId: clips[0].id,
        attempt: 1,
        providerTaskId: 'task',
        status: 'failed',
        audit: {
          technicalPassed: true,
          visionPassed: false,
          summary: 'Label drift',
          issues: ['Label drift'],
          suggestedRevision: revision,
        },
      },
    ],
    events: [],
    output: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  });
  const review = creatorPromptReviewSchema.parse({
    planId: session.plan.id,
    workflowVersion: workflow.version,
    hasBlockingIssues: false,
    clips: clips.map((clip) => ({ clipId: clip.id, compiledPrompt: clip.prompt, issues: [] })),
  });
  return { session, workflow, job, clips, revision, review };
}

test('late prompt reviews are discarded across a different session, plan, version, or edit state', () => {
  const { session, workflow, review } = fixture();
  const requested = savedPromptContext(session, workflow);
  assert.ok(requested);
  assert.equal(promptReviewMatches(review, requested, savedPromptContext(session, workflow)), true);
  assert.equal(
    promptReviewMatches(review, requested, { ...requested, sessionId: randomUUID() }),
    false,
  );
  assert.equal(
    promptReviewMatches(review, requested, { ...requested, planId: randomUUID() }),
    false,
  );
  assert.equal(promptReviewMatches(review, requested, { ...requested, workflowVersion: 4 }), false);
  assert.equal(
    promptReviewMatches(review, requested, savedPromptContext(session, workflow, true)),
    false,
  );
  assert.equal(savedPromptContext(session, { ...workflow, version: 4 }), null);
  assert.equal(
    promptReviewMatches({ ...review, planId: randomUUID() }, requested, requested),
    false,
  );
});

test('a staged revision changes only the matching shot wording and preserves the saved draft', () => {
  const { session, workflow, job, clips, revision } = fixture();
  const draft = planDraft(session.plan);
  const before = structuredClone(draft);
  const staged = stageClipRevision(draft, session, workflow, job, clips[0].id, 1);
  assert.ok(staged && draft);
  assert.deepEqual(draft, before);
  assert.deepEqual(staged, {
    ...draft,
    clips: [
      {
        ...draft.clips[0],
        prompt: revision.prompt,
        camera: revision.camera,
        lighting: revision.lighting,
      },
      draft.clips[1],
    ],
  });
  assert.equal(session.approval, null);
  assert.equal(job.status, 'failed');
});

test('earlier or active jobs, stale plans and any existing draft edits cannot stage a repair', () => {
  const { session, workflow, job, clips } = fixture();
  const draft = planDraft(session.plan);
  assert.ok(draft);
  const stage = (candidate = job, blocked = false) =>
    stageClipRevision(draft, session, workflow, candidate, clips[0].id, 1, blocked);
  assert.equal(stage({ ...job, planId: randomUUID() }), null);
  assert.equal(stage({ ...job, sessionId: randomUUID() }), null);
  assert.equal(stage({ ...job, workflowVersion: 4 }), null);
  assert.equal(stage({ ...job, status: 'running' }), null);
  assert.equal(stage(job, true), null);
  assert.equal(
    stageClipRevision(draft, session, { ...workflow, version: 4 }, job, clips[0].id, 1),
    null,
  );
  assert.equal(
    stageClipRevision(
      { ...draft, caption: 'Unsaved edit' },
      session,
      workflow,
      job,
      clips[0].id,
      1,
    ),
    null,
  );
  assert.equal(stageClipRevision(draft, session, workflow, job, randomUUID(), 1), null);
});

test('the latest attempt determines whether a repair suggestion is available', () => {
  const { session, workflow, job, clips } = fixture();
  const updated = creatorJobSchema.parse({
    ...job,
    clips: [
      ...job.clips,
      {
        ...job.clips[0],
        attempt: 2,
        audit: {
          technicalPassed: true,
          visionPassed: true,
          summary: 'Passed',
          issues: [],
          suggestedRevision: null,
        },
      },
    ],
  });
  assert.equal(
    stageClipRevision(planDraft(session.plan), session, workflow, updated, clips[0].id, 2),
    null,
  );
});

test('an earlier displayed attempt cannot apply the later attempt’s different suggestion', () => {
  const { session, workflow, job, clips, revision } = fixture();
  const laterRevision = { ...revision, prompt: 'The later attempt needs a different correction.' };
  const laterAttempt = {
    ...job.clips[0],
    attempt: 2,
    audit: {
      technicalPassed: true,
      visionPassed: false,
      summary: 'A different issue',
      issues: ['A different issue'],
      suggestedRevision: laterRevision,
    },
  };
  const updated = creatorJobSchema.parse({ ...job, clips: [laterAttempt, ...job.clips] });
  const draft = planDraft(session.plan);
  assert.equal(stageClipRevision(draft, session, workflow, updated, clips[0].id, 1), null);
  assert.equal(
    stageClipRevision(draft, session, workflow, updated, clips[0].id, 2)?.clips[0].prompt,
    laterRevision.prompt,
  );
});
