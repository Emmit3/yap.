import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { creatorJobSchema, creatorSessionSchema } from '@yap/contracts/creator';
import { workflowSchema } from '@yap/contracts/workflow';
import { rovingIndex } from '../src/creator/keyboard.js';
import {
  approvalCurrent,
  checkedPhotos,
  clipPreviewIsCurrent,
  generatedSeconds,
  nextQuestion,
  outputIsCurrent,
  planCurrent,
  sourceInput,
  startingPrompt,
  withAnswer,
} from '../src/creator/model.js';

function fixture() {
  const at = '2026-11-14T12:00:00.000Z';
  const workflow = workflowSchema.parse({
    id: randomUUID(),
    version: 3,
    contentRevision: 1,
    title: 'Untitled film',
    input: 'A film from my photos.',
    brief: { productName: 'Your business', audience: 'Local customers', callToAction: 'Visit us' },
    assets: [],
    messages: [],
    questions: [
      { id: 'productName', field: 'productName', status: 'open', question: 'What is it called?' },
      { id: 'audience', field: 'audience', status: 'open', question: 'Who is it for?' },
    ],
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
  const planId = randomUUID();
  const approvalId = randomUUID();
  const session = creatorSessionSchema.parse({
    id: randomUUID(),
    version: 2,
    workflowId: workflow.id,
    input: { mode: 'media', prompt: 'A film from my photos.', urls: [] },
    answers: [],
    research: null,
    selectedReferenceIds: [],
    externalReferences: [],
    plan: {
      id: planId,
      workflowVersion: workflow.version,
      scriptId: workflow.script.id,
      sourceScenesId: workflow.scenes.id,
      caption: '',
      clips: [
        {
          id: randomUUID(),
          sceneId: workflow.scenes.scenes[0].id,
          seconds: 5,
          prompt: 'Show the supplied product',
          camera: 'Slow push',
          lighting: 'Soft daylight',
        },
      ],
      model: 'gen4.5',
      ratio: '720:1280',
      hasAudio: false,
      maxAttemptsPerClip: 2,
      maxGeneratedSeconds: 10,
      createdAt: at,
    },
    approval: { id: approvalId, planId, workflowVersion: workflow.version, approvedAt: at },
    createdAt: at,
    updatedAt: at,
  });
  const job = creatorJobSchema.parse({
    id: randomUUID(),
    requestId: randomUUID(),
    sessionId: session.id,
    kind: 'production',
    status: 'succeeded',
    phase: 'complete',
    sourceVersion: 2,
    workflowVersion: workflow.version,
    approvalId,
    clips: [],
    events: [],
    output: {
      bytes: 1000,
      sha256: 'a'.repeat(64),
      duration: 5,
      width: 1080,
      height: 1920,
      hasAudio: false,
    },
    error: null,
    createdAt: at,
    updatedAt: at,
  });
  return { session, workflow, job };
}

test('media can start with a neutral request while an empty text-only start is rejected', () => {
  const prompt = startingPrompt('', 2);
  assert.match(prompt, /Ask me what they show/);
  assert.equal(sourceInput('media', prompt, '', '').mode, 'media');
  assert.equal(startingPrompt('  My actual direction  ', 2), 'My actual direction');
  assert.throws(() => startingPrompt('  ', 0), /Add a photo or a little text/);
  assert.throws(() => sourceInput('text', '', '', ''), /prompt/);
});

test('saved source preferences are explicit and public source URLs are validated', () => {
  assert.deepEqual(
    sourceInput(
      'text',
      ' Film idea ',
      ' Seattle ',
      'https://example.com/product\nhttps://example.com/product',
      { duration: 30, platform: 'youtube', tone: 'bold' },
    ),
    {
      mode: 'text',
      prompt: 'Film idea',
      location: 'Seattle',
      urls: ['https://example.com/product'],
      duration: 30,
      platform: 'youtube',
      tone: 'bold',
    },
  );
  assert.throws(() => sourceInput('text', 'Film idea', '', 'http://example.com'), /HTTPS/);
  assert.throws(
    () =>
      sourceInput(
        'text',
        'Film idea',
        '',
        Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(' '),
      ),
    /urls/,
  );
});

test('template brief defaults never suppress questions until a real answer is saved', () => {
  const { session, workflow } = fixture();
  assert.equal(nextQuestion(session, workflow)?.id, 'productName');
  session.answers = withAnswer(session.answers, 'productName', 'Mori');
  assert.equal(nextQuestion(session, workflow)?.id, 'audience');
  workflow.questions[1].status = 'answered';
  workflow.questions[1].answer = 'Ceramic collectors';
  assert.equal(nextQuestion(session, workflow), null);
});

test('research questions are adaptive and an answer correction replaces the prior answer', () => {
  const { session, workflow } = fixture();
  session.research = {
    summary: 'More direction needed.',
    productFacts: [],
    cinematography: '',
    sources: [],
    references: [],
    limitations: [],
    questions: [
      { id: 'location', question: 'Where is this made?', why: 'Use the right setting.' },
      { id: 'style', question: 'How should it feel?', why: 'Shape the mood.' },
    ],
  };
  session.answers = withAnswer(session.answers, 'location', 'Seattle');
  session.answers = withAnswer(session.answers, 'location', '  Portland  ');
  assert.deepEqual(session.answers, [{ questionId: 'location', answer: 'Portland' }]);
  assert.equal(nextQuestion(session, workflow)?.id, 'style');
});

test('a media-only operational starter is never treated as the answer to what photos show', () => {
  const { session, workflow } = fixture();
  session.input.prompt = startingPrompt('', 1);
  workflow.questions = [
    {
      id: 'productDescription',
      field: 'productDescription',
      status: 'answered',
      question: 'What do the photos show?',
      answer: session.input.prompt,
    },
  ];
  assert.equal(nextQuestion(session, workflow)?.id, 'productDescription');
  session.research = {
    summary: 'Describe the supplied photos.',
    productFacts: [],
    cinematography: '',
    sources: [],
    references: [],
    limitations: [],
    questions: [
      {
        id: 'productDescription',
        question: 'What do the photos show?',
        why: 'Your description supplies the facts.',
      },
    ],
  };
  assert.equal(nextQuestion(session, workflow)?.id, 'productDescription');
  session.answers = [
    { questionId: 'productDescription', answer: 'These are the ceramic cups we make.' },
  ];
  assert.equal(nextQuestion(session, workflow), null);
});

test('changing workflow, script, scenes, or approval hides an obsolete final export', () => {
  const { session, workflow, job } = fixture();
  assert.equal(planCurrent(session, workflow), true);
  assert.equal(approvalCurrent(session, workflow), true);
  assert.equal(outputIsCurrent(job, session, workflow), true);
  assert.equal(clipPreviewIsCurrent(job, session, workflow), true);
  assert.equal(clipPreviewIsCurrent(job, { ...session, approval: null }, workflow), false);
  assert.equal(clipPreviewIsCurrent({ ...job, workflowVersion: 1 }, session, workflow), false);
  assert.equal(outputIsCurrent({ ...job, approvalId: randomUUID() }, session, workflow), false);
  assert.equal(outputIsCurrent({ ...job, status: 'failed' }, session, workflow), false);
  assert.equal(
    outputIsCurrent(job, session, { ...workflow, version: workflow.version + 1 }),
    false,
  );
  assert.ok(workflow.script && workflow.scenes);
  assert.equal(
    planCurrent(session, { ...workflow, script: { ...workflow.script, id: randomUUID() } }),
    false,
  );
  assert.equal(
    planCurrent(session, { ...workflow, scenes: { ...workflow.scenes, id: randomUUID() } }),
    false,
  );
});

test('the displayed attempt budget includes every clip and photo constraints are enforced', () => {
  const { session } = fixture();
  assert.ok(session.plan);
  assert.equal(generatedSeconds(session.plan.clips), 10);
  const photo = new File(['image bytes'], 'cup.webp', { type: 'image/webp' });
  assert.deepEqual(checkedPhotos([photo], 18, 1), [photo]);
  assert.throws(() => checkedPhotos([photo], 19, 1), /up to 20/);
  assert.throws(
    () => checkedPhotos([new File(['x'], 'wrong.svg', { type: 'image/svg+xml' })], 0, 0),
    /JPEG, PNG or WebP/,
  );
  assert.throws(
    () => checkedPhotos([new File([], 'empty.png', { type: 'image/png' })], 0, 0),
    /under 10 MiB/,
  );
});

test('horizontal tabs support wrapping arrows, Home and End without handling unrelated keys', () => {
  assert.equal(rovingIndex('ArrowRight', 1, 2), 0);
  assert.equal(rovingIndex('ArrowLeft', 0, 2), 1);
  assert.equal(rovingIndex('Home', 1, 2), 0);
  assert.equal(rovingIndex('End', 0, 3), 2);
  assert.equal(rovingIndex('Tab', 0, 2), null);
  assert.equal(rovingIndex('ArrowRight', 0, 0), null);
});
