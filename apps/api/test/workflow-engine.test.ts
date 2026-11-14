import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { type Workflow, type WorkflowImageAsset } from '@yap/contracts/workflow';
import {
  approveWorkflow,
  approveAllWorkflow,
  buildGuidedScenes,
  buildGuidedScript,
  createWorkflow,
  editWorkflowScript,
  invalidateWorkflowContent,
  queryWorkflow,
  refineWorkflow,
  setWorkflowScenes,
  setWorkflowScript,
  verifyWorkflow,
} from '../src/workflow-engine.js';

function complete(duration: 15 | 30 | 60 = 30): Workflow {
  return createWorkflow({
    input: 'Make a video about a reusable water bottle.',
    brief: {
      productName: 'Loop bottle',
      productDescription: 'A reusable steel bottle with a carrying loop.',
      audience: 'Students who carry a drink to class',
      keyBenefits: [
        'A carrying loop',
        'A lid that twists open',
        'Refill instead of buying another bottle',
      ],
      callToAction: 'Choose the bottle color you like.',
      duration,
    },
  });
}

function asset(): WorkflowImageAsset {
  return {
    id: randomUUID(),
    filename: 'bottle.png',
    mimeType: 'image/png',
    bytes: 100,
    width: 10,
    height: 10,
    sha256: 'a'.repeat(64),
    description: 'Creator calls this the blue bottle.',
    createdAt: new Date().toISOString(),
  };
}

test('natural language input remains queryable with reviewable defaults and optional refinement questions', () => {
  const workflow = createWorkflow({ input: 'Make this a fun product launch.' });
  assert.equal(workflow.brief.productName, 'Your business');
  assert.equal(workflow.brief.duration, 30);
  assert.equal(workflow.questions.filter((question) => question.status === 'open').length, 4);
  assert.equal(verifyWorkflow(workflow).brief.state, 'needs_review');
  const before = structuredClone(workflow);
  const result = queryWorkflow(workflow, 'What is missing?');
  assert.match(result.answer, /product or idea called/);
  assert.equal(result.workflowVersion, 1);
  assert.deepEqual(workflow, before);
  assert.throws(() => buildGuidedScript(workflow), /Approve the current brief/);
  const acknowledged = refineWorkflow(workflow, {
    expectedVersion: workflow.version,
    answers: { audience: 'Local customers' },
  });
  assert.equal(
    acknowledged.questions.find((item) => item.field === 'audience')?.status,
    'answered',
  );
  assert.equal(
    invalidateWorkflowContent(acknowledged).questions.find((item) => item.field === 'audience')
      ?.status,
    'answered',
  );
});

test('explicit answers refine the brief without guessing image facts or mutating the original', () => {
  const workflow = createWorkflow({ input: 'A video about our new bottle.' });
  workflow.assets.push(asset());
  const next = refineWorkflow(workflow, {
    expectedVersion: 1,
    answers: {
      productName: 'Loop bottle',
      productDescription: 'A reusable steel bottle.',
      audience: 'Students',
      keyBenefits: 'Carrying loop; Refillable\nTwist lid',
      callToAction: 'Pick a color.',
      imageDirection: 'Show the carrying loop in a close view.',
    },
  });
  assert.equal(workflow.brief.productName, 'Your business');
  assert.equal(next.contentRevision, 2);
  assert.equal(next.version, 1);
  assert.deepEqual(next.brief.keyBenefits, ['Carrying loop', 'Refillable', 'Twist lid']);
  assert.equal(
    next.questions.every((question) => question.status === 'answered'),
    true,
  );
  assert.equal(verifyWorkflow(next).brief.state, 'needs_review');
  const imageAnswer = queryWorkflow(next, 'What do the images show?');
  assert.match(imageAnswer.answer, /has not interpreted image contents/);
  assert.equal(imageAnswer.evidence[0]?.id, workflow.assets[0]!.id);
  assert.throws(
    () =>
      refineWorkflow(workflow, { expectedVersion: 1, answers: { keyBenefits: 'a'.repeat(501) } }),
    /500 characters/,
  );
});

test('brief, script, and scenes require ordered approvals and exact target timing', () => {
  for (const duration of [15, 30, 60] as const) {
    let workflow = complete(duration);
    assert.equal(verifyWorkflow(workflow).brief.state, 'needs_review');
    assert.throws(() => buildGuidedScript(workflow), /Approve/);
    workflow = approveWorkflow(workflow, 'brief');
    workflow = setWorkflowScript(workflow, buildGuidedScript(workflow));
    assert.equal(
      workflow.script!.segments.reduce((sum, segment) => sum + segment.seconds, 0),
      duration,
    );
    assert.equal(verifyWorkflow(workflow).script.state, 'needs_review');
    assert.throws(() => buildGuidedScenes(workflow), /Approve the current script/);
    workflow = approveWorkflow(workflow, 'script');
    workflow = setWorkflowScenes(workflow, buildGuidedScenes(workflow));
    workflow = approveWorkflow(workflow, 'scenes');
    assert.equal(verifyWorkflow(workflow).scenes.state, 'approved');
    assert.equal(
      workflow.scenes!.scenes.reduce((sum, scene) => sum + scene.seconds, 0),
      duration,
    );
    assert.deepEqual(
      workflow.scenes!.scenes.map((scene) => scene.scriptSegmentId),
      workflow.script!.segments.map((segment) => segment.id),
    );
  }
});

test('script edits and content changes invalidate downstream artifacts and approvals', () => {
  let workflow = approveWorkflow(complete(), 'brief');
  workflow = approveWorkflow(setWorkflowScript(workflow, buildGuidedScript(workflow)), 'script');
  workflow = approveWorkflow(setWorkflowScenes(workflow, buildGuidedScenes(workflow)), 'scenes');
  const previousScript = workflow.script!;
  const editRequest = {
    expectedVersion: workflow.version,
    hook: 'Bring your own bottle.',
    segments: previousScript.segments,
    caption: previousScript.caption,
  };
  const edited = editWorkflowScript(workflow, editRequest);
  assert.notEqual(edited.script!.id, previousScript.id);
  assert.equal(edited.approvals.brief, workflow.contentRevision);
  assert.equal(edited.approvals.script, null);
  assert.equal(edited.scenes, null);
  assert.equal(edited.approvals.scenes, null);
  const invalidated = invalidateWorkflowContent({ ...workflow, assets: [asset()] });
  assert.equal(invalidated.contentRevision, workflow.contentRevision + 1);
  assert.equal(invalidated.script, null);
  assert.deepEqual(invalidated.approvals, { brief: null, script: null, scenes: null });
  assert.equal(
    invalidated.questions.find((question) => question.field === 'imageDirection')?.status,
    'open',
  );
});

test('verification rejects stale sources, missing scene coverage, invalid assets, and timing drift', () => {
  let workflow = approveWorkflow(complete(), 'brief');
  const script = buildGuidedScript(workflow);
  assert.throws(
    () => setWorkflowScript(workflow, { ...script, sourceRevision: 999 }),
    /failed verification/,
  );
  assert.throws(
    () =>
      setWorkflowScript(workflow, {
        ...script,
        segments: script.segments.map((segment, index) => ({
          ...segment,
          seconds: segment.seconds + (index === 0 ? 1 : 0),
        })),
      }),
    /failed verification/,
  );
  workflow = approveWorkflow(setWorkflowScript(workflow, script), 'script');
  const scenes = buildGuidedScenes(workflow);
  assert.throws(
    () => setWorkflowScenes(workflow, { ...scenes, scenes: scenes.scenes.slice(1) }),
    /failed verification/,
  );
  assert.throws(
    () =>
      setWorkflowScenes(workflow, {
        ...scenes,
        scenes: scenes.scenes.map((scene, index) => ({
          ...scene,
          assetIds: index === 0 ? [randomUUID()] : [],
        })),
      }),
    /failed verification/,
  );
  assert.throws(
    () => setWorkflowScenes(workflow, { ...scenes, sourceScriptId: randomUUID() }),
    /failed verification/,
  );
});

test('small business quick preparation creates reviewable proposals without forging approvals', () => {
  let workflow = createWorkflow({
    input: 'Make a promo for our matcha drinks.',
    title: 'Moss matcha',
  });
  const uploaded = asset();
  workflow = invalidateWorkflowContent({ ...workflow, assets: [uploaded] });
  const options = { requireApproval: false };
  workflow = setWorkflowScript(workflow, buildGuidedScript(workflow, options), options);
  workflow = setWorkflowScenes(workflow, buildGuidedScenes(workflow, options), options);
  assert.deepEqual(workflow.approvals, { brief: null, script: null, scenes: null });
  const verification = verifyWorkflow(workflow);
  assert.equal(verification.script.state, 'needs_review');
  assert.equal(verification.script.canApprove, false);
  assert.equal(verification.scenes.state, 'needs_review');
  assert.ok(workflow.scenes!.scenes.every((scene) => scene.assetIds[0] === uploaded.id));
  const approved = approveAllWorkflow(workflow);
  assert.equal(verifyWorkflow(approved).scenes.state, 'approved');
  assert.deepEqual(workflow.approvals, { brief: null, script: null, scenes: null });
});

test('guided scripts handle all allowed benefit counts and maximum natural language input', () => {
  const longInput = createWorkflow({ input: 'a'.repeat(8000) });
  assert.equal(longInput.input.length, 8000);
  assert.equal(longInput.brief.productDescription!.length, 4000);
  assert.doesNotThrow(() =>
    createWorkflow({
      input: 'Long form product details',
      brief: { keyBenefits: Array.from({ length: 10 }, () => 'a'.repeat(500)) },
    }),
  );
  for (let count = 1; count <= 10; count += 1) {
    const workflow = approveWorkflow(
      {
        ...complete(60),
        brief: {
          ...complete(60).brief,
          keyBenefits: Array.from({ length: count }, (_, index) => `Benefit ${index + 1}`),
        },
      },
      'brief',
    );
    const script = buildGuidedScript(workflow);
    assert.ok(script.segments.every((segment) => segment.text.length > 0));
  }
});
