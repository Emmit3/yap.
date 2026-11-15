import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  creatorSessionSchema,
  creatorQuoteSchema,
  type CreatorBudgetSnapshot,
} from '@yap/contracts/creator';
import {
  createWorkflow,
  setWorkflowScript,
  setWorkflowScenes,
  buildGuidedScenes,
} from '../../api/src/workflow-engine.js';
import {
  formatUsd,
  quoteIsAffordable,
  quoteIsCurrent,
  readSavedQuote,
  saveQuote,
} from '../src/creator/quote.js';
import { planDraft } from '../src/creator/model.js';
import { brandSnapshotSchema } from '@yap/contracts/production';

function fixture() {
  const now = Date.parse('2026-11-14T12:00:00.000Z'),
    at = new Date(now).toISOString();
  let workflow = createWorkflow({
    input: 'A quiet ceramic product film.',
    brief: { duration: 15, productName: 'Mori' },
  });
  workflow = setWorkflowScript(
    workflow,
    {
      id: randomUUID(),
      sourceRevision: workflow.contentRevision,
      hook: 'Take a closer look',
      segments: ['The detail', 'The craft', 'The collection'].map((text) => ({
        id: randomUUID(),
        text,
        seconds: 5,
      })),
      caption: 'Meet the collection.',
      provider: 'guided',
      createdAt: at,
    },
    { requireApproval: false },
  );
  workflow = setWorkflowScenes(workflow, buildGuidedScenes(workflow, { requireApproval: false }), {
    requireApproval: false,
  });
  workflow.version = 3;
  assert.ok(workflow.script && workflow.scenes);
  const session = creatorSessionSchema.parse({
    id: randomUUID(),
    version: 2,
    workflowId: workflow.id,
    input: { mode: 'text', prompt: workflow.input, urls: [] },
    answers: [],
    research: null,
    selectedReferenceIds: [],
    externalReferences: [],
    plan: {
      id: randomUUID(),
      workflowVersion: workflow.version,
      scriptId: workflow.script.id,
      sourceScenesId: workflow.scenes.id,
      caption: workflow.script.caption,
      clips: workflow.scenes.scenes.map((scene) => ({
        id: randomUUID(),
        sceneId: scene.id,
        seconds: scene.seconds,
        prompt: scene.visual,
        camera: 'Slow push',
        lighting: 'Soft daylight',
      })),
      provider: 'fal',
      model: 'seedance-v1.5-pro',
      ratio: '720:1280',
      hasAudio: false,
      maxAttemptsPerClip: 2,
      maxGeneratedSeconds: 30,
      createdAt: at,
    },
    approval: null,
    createdAt: at,
    updatedAt: at,
  });
  assert.ok(session.plan);
  const quote = creatorQuoteSchema.parse({
    estimateKind: 'conservative_ceiling',
    id: randomUUID(),
    sessionId: session.id,
    sessionVersion: session.version,
    workflowVersion: workflow.version,
    planId: session.plan.id,
    fingerprint: 'a'.repeat(64),
    provider: 'fal',
    model: 'seedance-v1.5-pro',
    ratio: '720:1280',
    hasAudio: false,
    currency: 'USD',
    maxCostCents: 105,
    createdAt: at,
    expiresAt: new Date(now + 600_000).toISOString(),
    approvedApprovalId: null,
    consumedByJobId: null,
    clips: session.plan.clips.map((clip) => ({
      clipId: clip.id,
      seconds: clip.seconds,
      attempt: 1,
      videoCents: 25,
      visionCents: 10,
      costCents: 35,
      reuse: null,
    })),
  });
  return { now, workflow, session, quote };
}

function overriddenFixture(landscape = false) {
  const value = fixture();
  const profile = landscape
    ? ('runway-gen4.5-landscape' as const)
    : ('runway-gen4.5-portrait' as const);
  assert.ok(value.session.plan);
  for (const clip of value.session.plan.clips) clip.videoProfileId = profile;
  value.session.plan.outputProfileId = landscape ? 'landscape-720' : 'portrait-720';
  value.quote.provider = 'runway';
  value.quote.model = 'gen4.5';
  value.quote.outputProfileId = value.session.plan.outputProfileId;
  value.quote.ratio = landscape ? '1280:720' : '720:1280';
  value.quote.clips = value.quote.clips.map((clip) => ({
    ...clip,
    videoProfileId: profile,
    provider: 'runway',
    model: 'gen4.5',
    ratio: value.quote.ratio,
    nativeWidth: landscape ? 1280 : 720,
    nativeHeight: landscape ? 720 : 1280,
  }));
  return value;
}

test('Fal Seedance 2.5 quotes retain exact per-shot model and native canvas identity', () => {
  for (const landscape of [false, true]) {
    const { session, workflow, quote, now } = overriddenFixture(landscape);
    const profile = landscape ? 'fal-seedance2.5-landscape' : 'fal-seedance2.5-portrait';
    for (const clip of session.plan!.clips) clip.videoProfileId = profile;
    quote.provider = 'fal';
    quote.model = 'seedance-2.5';
    quote.clips = quote.clips.map((clip) => ({
      ...clip,
      provider: 'fal',
      model: 'seedance-2.5',
      videoProfileId: profile,
    }));
    assert.equal(quoteIsCurrent(quote, session, workflow, now), true);
    assert.equal(
      quoteIsCurrent({ ...quote, model: 'seedance-v1.5-pro' }, session, workflow, now),
      false,
    );
    assert.equal(
      quoteIsCurrent(
        { ...quote, clips: quote.clips.map((clip) => ({ ...clip, model: 'gen4.5' })) },
        session,
        workflow,
        now,
      ),
      false,
    );
  }
});

test('per-shot Runway quotes remain current over historical fal plan metadata only for exact saved choices', () => {
  const { session, workflow, quote, now } = overriddenFixture();
  assert.equal(session.plan!.provider, 'fal');
  assert.equal(quoteIsCurrent(quote, session, workflow, now), true);
  for (const invalid of [
    { ...quote, provider: 'fal' as const, model: 'seedance-v1.5-pro' as const },
    {
      ...quote,
      clips: quote.clips.map((clip, index) =>
        index === 0 ? { ...clip, videoProfileId: 'runway-gen4turbo-portrait' as const } : clip,
      ),
    },
    {
      ...quote,
      clips: quote.clips.map((clip, index) =>
        index === 0 ? { ...clip, videoProfileId: undefined } : clip,
      ),
    },
    {
      ...quote,
      clips: quote.clips.map((clip, index) =>
        index === 0
          ? { ...clip, provider: 'fal' as const, model: 'seedance-v1.5-pro' as const }
          : clip,
      ),
    },
  ])
    assert.equal(quoteIsCurrent(invalid, session, workflow, now), false);
  session.plan!.clips[1]!.videoProfileId = 'runway-gen4turbo-portrait';
  assert.equal(quoteIsCurrent(quote, session, workflow, now), false);
});

test('landscape quote delivery and brand identity match the exact saved output and frozen snapshot', () => {
  const { session, workflow, quote, now } = overriddenFixture(true);
  const brand = brandSnapshotSchema.parse({
    name: 'Mori',
    font: 'sans',
    inkColor: '#171717',
    paperColor: '#ffffff',
    accentColor: '#247b58',
    endCard: { enabled: false, title: '', detail: '', seconds: 1 },
    version: 1,
    updatedAt: new Date(now).toISOString(),
    logo: null,
    sha256: 'c'.repeat(64),
  });
  session.plan!.brandSnapshot = brand;
  quote.brandSnapshot = structuredClone(brand);
  assert.equal(quoteIsCurrent(quote, session, workflow, now), true);
  for (const invalid of [
    { ...quote, ratio: '720:1280' as const },
    { ...quote, outputProfileId: 'portrait-720' as const },
    { ...quote, brandSnapshot: { ...brand, sha256: 'd'.repeat(64) } },
    { ...quote, brandSnapshot: null },
  ])
    assert.equal(quoteIsCurrent(invalid, session, workflow, now), false);
  session.plan!.outputProfileId = 'portrait-1080';
  assert.equal(quoteIsCurrent(quote, session, workflow, now), false);
});

test('draft saves retain explicit output, brand and per-shot choices without inventing historical fields', () => {
  const historical = fixture().session.plan;
  assert.ok(historical);
  assert.equal('outputProfileId' in planDraft(historical)!, false);
  assert.equal('brandSnapshot' in planDraft(historical)!, false);
  const { session } = overriddenFixture(true);
  session.plan!.brandSnapshot = null;
  const saved = planDraft(session.plan);
  assert.equal(saved?.outputProfileId, 'landscape-720');
  assert.equal(saved?.brandSnapshot, null);
  assert.equal(saved?.clips[0]?.videoProfileId, 'runway-gen4.5-landscape');
  assert.equal('outputProfileId' in historical, false);
});

test('subtitle choices must match the saved quote, including historical omission', () => {
  const { session, workflow, quote, now } = fixture();
  assert.ok(session.plan);
  assert.equal(quoteIsCurrent(quote, session, workflow, now), true);
  session.plan.subtitlesEnabled = true;
  assert.equal(quoteIsCurrent(quote, session, workflow, now), false);
  quote.subtitlesEnabled = true;
  assert.equal(quoteIsCurrent(quote, session, workflow, now), true);
  session.plan.subtitlesEnabled = false;
  assert.equal(quoteIsCurrent(quote, session, workflow, now), false);
  quote.subtitlesEnabled = false;
  assert.equal(quoteIsCurrent(quote, session, workflow, now), true);
});

test('displayed money preserves exact server cents, including zero, and refuses invalid costs', () => {
  assert.equal(formatUsd(105), '$1.05');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(3000), '$30.00');
  for (const value of [-1, NaN, Infinity, 1.2]) assert.throws(() => formatUsd(value));
});

test('fresh quote validity binds exact saved versions, provider, clip identity and expiry', () => {
  const { quote, session, workflow, now } = fixture();
  assert.equal(quoteIsCurrent(quote, session, workflow, now), true);
  for (const invalid of [
    { ...quote, sessionId: randomUUID() },
    { ...quote, planId: randomUUID() },
    { ...quote, sessionVersion: session.version + 1 },
    { ...quote, workflowVersion: workflow.version + 1 },
    { ...quote, provider: 'runway' as const },
    { ...quote, maxCostCents: 1 },
    { ...quote, consumedByJobId: randomUUID() },
    {
      ...quote,
      clips: quote.clips.map((clip, index) => (index === 0 ? { ...clip, seconds: 6 } : clip)),
    },
  ])
    assert.equal(quoteIsCurrent(invalid, session, workflow, now), false);
  assert.equal(quoteIsCurrent(quote, session, workflow, Date.parse(quote.expiresAt)), false);
});

test('an approved pending quote survives the exact approval-only version bumps and reload snapshot flags', () => {
  const { quote, session, workflow, now } = fixture();
  const approvalId = randomUUID();
  session.version += 1;
  workflow.version += 1;
  session.plan!.workflowVersion = workflow.version;
  session.approval = {
    id: approvalId,
    planId: session.plan!.id,
    workflowVersion: workflow.version,
    quoteId: quote.id,
    approvedAt: new Date(now).toISOString(),
  };
  assert.equal(quote.approvedApprovalId, null, 'POST quote snapshot predates server approval');
  assert.equal(quoteIsCurrent(quote, session, workflow, now), true);
  assert.equal(
    quoteIsCurrent({ ...quote, approvedApprovalId: approvalId }, session, workflow, now),
    true,
  );
  assert.equal(
    quoteIsCurrent({ ...quote, approvedApprovalId: randomUUID() }, session, workflow, now),
    false,
  );
  session.version += 1;
  assert.equal(quoteIsCurrent(quote, session, workflow, now), false);
});

test('budget review respects shared available funds and shows verified reused clips at zero additional cost', () => {
  const { quote } = fixture();
  const budget: CreatorBudgetSnapshot = {
    scope: 'creator_app',
    currency: 'USD',
    limitCents: 3000,
    chargedCents: 100,
    reservedCents: 50,
    availableCents: 2850,
  };
  assert.equal(quoteIsAffordable(quote, budget), true);
  assert.equal(quoteIsAffordable(quote, { ...budget, availableCents: 104 }), false);
  assert.equal(quoteIsAffordable(quote, null), false);
  const free = {
    ...quote,
    maxCostCents: 0,
    clips: quote.clips.map((clip) => ({
      ...clip,
      videoCents: 0,
      visionCents: 0,
      costCents: 0,
      reuse: { jobId: randomUUID(), attempt: 1, sha256: 'b'.repeat(64) },
    })),
  };
  assert.equal(quoteIsAffordable(free, { ...budget, availableCents: 0 }), true);
});

test('the exact quote persists without repricing and malformed or mismatched records fail closed', () => {
  const { quote, session } = fixture();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  assert.equal(readSavedQuote(storage, session.id), null);
  saveQuote(storage, quote);
  assert.deepEqual(readSavedQuote(storage, session.id), quote);
  const key = [...values.keys()][0];
  for (const invalid of [
    '[]',
    'null',
    'broken',
    JSON.stringify({
      version: 1,
      sessionId: session.id,
      quote: { ...quote, sessionId: randomUUID() },
    }),
    JSON.stringify({ version: 1, sessionId: session.id, quote: { ...quote, maxCostCents: 1 } }),
  ]) {
    values.set(key, invalid);
    assert.throws(() => readSavedQuote(storage, session.id), /fresh quote/);
  }
  assert.throws(
    () => saveQuote({ getItem: () => null, setItem() {} }, quote),
    /No paid work was submitted/,
  );
});

test('a narration line item must be part of the quote total and match the plan sound', () => {
  const { session, workflow, quote, now } = fixture();
  const audio = { voice: 'marin' as const, musicTrackId: 'calm' };
  const narrated = { ...quote, hasAudio: true, audio, audioCents: 30, narratedSegments: 3 };
  const plan = { ...session.plan!, hasAudio: true, audio };
  assert.equal(
    quoteIsCurrent({ ...narrated, maxCostCents: 135 }, { ...session, plan }, workflow, now),
    true,
  );
  assert.equal(
    quoteIsCurrent({ ...narrated, maxCostCents: 105 }, { ...session, plan }, workflow, now),
    false,
    'a total that leaves narration out is not shown as approvable',
  );
  assert.equal(
    quoteIsCurrent({ ...narrated, maxCostCents: 135 }, session, workflow, now),
    false,
    'a quote with sound does not match a silent plan',
  );
});
