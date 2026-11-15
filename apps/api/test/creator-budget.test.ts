import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import {
  creatorSessionSchema,
  creatorJobSchema,
  type CreatorSession,
  type CreatorQuote,
} from '@yap/contracts/creator';
import { CreatorRepository } from '../src/creator-repository.js';
import { buildCreatorQuote, productionProfile, quoteFingerprint } from '../src/creator-budget.js';
import { createWorkflow } from '../src/workflow-engine.js';

async function storage(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-creator-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'creator.json');
  return { file, repository: await CreatorRepository.open(file) };
}
function creation() {
  const now = new Date().toISOString();
  const workflow = createWorkflow({ input: 'Ceramic mugs in a studio', brief: { duration: 15 } });
  const session = creatorSessionSchema.parse({
    id: randomUUID(),
    version: 1,
    workflowId: workflow.id,
    input: { mode: 'text', prompt: 'Ceramic mugs in a studio', urls: [] },
    answers: [],
    research: null,
    selectedReferenceIds: [],
    externalReferences: [],
    approval: null,
    plan: {
      id: randomUUID(),
      workflowVersion: workflow.version,
      scriptId: randomUUID(),
      sourceScenesId: randomUUID(),
      caption: 'Meet your new everyday cup.',
      provider: 'runway',
      model: 'gen4.5',
      ratio: '720:1280',
      hasAudio: false,
      maxAttemptsPerClip: 2,
      maxGeneratedSeconds: 30,
      createdAt: now,
      clips: Array.from({ length: 3 }, () => ({
        id: randomUUID(),
        sceneId: randomUUID(),
        seconds: 5,
        prompt: 'A ceramic mug sits on a neutral surface.',
        camera: 'Slow push in.',
        lighting: 'Soft studio light.',
      })),
    },
    createdAt: now,
    updatedAt: now,
  });
  return { workflow, session, profile: productionProfile({}) };
}
async function approve(
  repository: CreatorRepository,
  session: CreatorSession,
  quote: CreatorQuote,
) {
  return repository.approveQuote(
    {
      ...session,
      approval: {
        id: randomUUID(),
        planId: session.plan!.id,
        workflowVersion: quote.workflowVersion,
        quoteId: quote.id,
        approvedAt: new Date().toISOString(),
      },
    },
    session.version,
    quote.id,
  );
}
function production(session: CreatorSession, requestId = randomUUID()) {
  const now = new Date().toISOString();
  return creatorJobSchema.parse({
    id: randomUUID(),
    requestId,
    sessionId: session.id,
    kind: 'production',
    status: 'queued',
    phase: 'queued',
    sourceVersion: session.version,
    workflowVersion: session.approval!.workflowVersion,
    approvalId: session.approval!.id,
    quoteId: session.approval!.quoteId,
    clips: [],
    events: [],
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
}

test('H3 Max quotes require a selected source and bind the generated keyframe hash', () => {
  const { workflow, session } = creation();
  session.plan!.provider = 'fal';
  session.plan!.model = 'minimax-h3-max';
  const profile = productionProfile({
    profile: {
      provider: 'fal',
      model: 'minimax-h3-max',
      minSeconds: 2,
      maxSeconds: 10,
      rateCentsPerSecond: 10,
    },
  });
  assert.throws(() => buildCreatorQuote(session, workflow, profile, []), {
    code: 'CREATOR_KEYFRAME_REQUIRED',
  });
  session.plan!.clips = session.plan!.clips.map((clip) => ({
    ...clip,
    keyframeId: randomUUID(),
    keyframeSha256: 'a'.repeat(64),
  }));
  const quote = buildCreatorQuote(session, workflow, profile, []);
  assert.equal(quote.maxCostCents, 180);
  const original = quote.fingerprint;
  session.plan!.clips[0]!.keyframeSha256 = 'b'.repeat(64);
  assert.notEqual(quoteFingerprint(session, workflow, profile), original);
  assert.equal(session.approval, null);
});

test('shared durable ledger serializes concurrent spend, holds unknown cost, and settles only known charges', async (t) => {
  const { file, repository } = await storage(t);
  const requests = Array.from({ length: 7 }, (_, index) => ({
    idempotencyKey: 'research-' + index,
    category: 'research' as const,
    sourceId: 'query-' + index,
    amountCents: 500,
  }));
  const results = await Promise.allSettled(requests.map((request) => repository.reserve(request)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 6);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await repository.budget()).availableCents, 0);
  const first = await repository.reserve(requests[0]!);
  assert.equal(
    (await repository.budget()).reservedCents,
    3000,
    'an idempotent reservation does not add a second hold',
  );
  await assert.rejects(repository.reserve({ ...requests[0]!, amountCents: 501 }), {
    code: 'CREATOR_BUDGET_REQUEST_CONFLICT',
  });
  await assert.rejects(repository.settle(first.id, 501), { code: 'CREATOR_CHARGE_INVALID' });
  await repository.settle(first.id, 120);
  await repository.settle(first.id, 120);
  await assert.rejects(repository.settle(first.id, 0), { code: 'CREATOR_CHARGE_SETTLED' });
  const restarted = await CreatorRepository.open(file);
  assert.deepEqual(await restarted.budget(), {
    scope: 'creator_app',
    currency: 'USD',
    limitCents: 3000,
    reservedCents: 2500,
    chargedCents: 120,
    availableCents: 380,
  });
  await assert.rejects(restarted.reserve({ ...requests[6]!, amountCents: 381 }), {
    code: 'CREATOR_BUDGET_EXCEEDED',
  });
});

test('production admission atomically consumes its quote and reserves the exact ceiling once across restart', async (t) => {
  const { file, repository } = await storage(t);
  const { workflow, session, profile } = creation();
  await repository.create(session);
  const quote = await repository.addQuote(buildCreatorQuote(session, workflow, profile, []));
  assert.equal(quote.maxCostCents, 270);
  assert.ok(
    quote.clips.every(
      (clip) => clip.attempt === 1 && clip.videoCents === 80 && clip.visionCents === 10,
    ),
  );
  const approved = await approve(repository, session, quote);
  const job = production(approved);
  const [first, duplicate] = await Promise.all([
    repository.addJob(job, approved.version),
    repository.addJob({ ...job, id: randomUUID() }, approved.version),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.reservationIds?.length, 3);
  assert.equal((await repository.budget()).reservedCents, 270);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.quotes[0].consumedByJobId, first.id);
  assert.equal(
    saved.budget.reservations.length,
    3,
    'the admission write persists holds with the job before submission',
  );
  await repository.updateJob(session.id, first.id, (current) => ({
    ...current,
    status: 'running',
    clips: [
      {
        clipId: session.plan!.clips[0]!.id,
        attempt: 1,
        providerTaskId: 'submitted-task',
        status: 'generating',
        audit: null,
        reservationId: first.reservationIds![0],
      },
    ],
  }));
  const restarted = await CreatorRepository.open(file);
  const interrupted = await restarted.job(session.id, first.id);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.error?.code, 'CREATOR_INTERRUPTED');
  assert.equal(
    (await restarted.budget()).reservedCents,
    270,
    'unknown provider outcomes retain full holds after restart',
  );
  assert.equal(
    (await restarted.addJob(job, approved.version)).id,
    first.id,
    'same request returns its receipt without replay',
  );
  await assert.rejects(restarted.addJob(production(approved), approved.version), {
    code: 'CREATOR_QUOTE_CONSUMED',
  });
  await restarted.releaseUnusedReservations(session.id, first.id);
  assert.equal(
    (await restarted.budget()).reservedCents,
    90,
    'only attempts proven never started are released',
  );
  const retry = buildCreatorQuote(approved, workflow, profile, await restarted.jobs(session.id));
  assert.equal(retry.clips[0]?.attempt, 2);
  assert.equal(retry.clips[1]?.attempt, 1);
});

test('concurrent nonvideo spend cannot partially fund a production job or consume its quote', async (t) => {
  const { repository } = await storage(t);
  const { workflow, session, profile } = creation();
  await repository.create(session);
  const quote = await repository.addQuote(buildCreatorQuote(session, workflow, profile, []));
  const approved = await approve(repository, session, quote);
  await repository.reserve({
    idempotencyKey: 'shared-drafting',
    category: 'drafting',
    sourceId: 'draft',
    amountCents: 2800,
  });
  await assert.rejects(repository.addJob(production(approved), approved.version), {
    code: 'CREATOR_BUDGET_EXCEEDED',
  });
  assert.equal((await repository.jobs(session.id)).length, 0);
  assert.equal(
    (await repository.budget()).reservedCents,
    2800,
    'failed admission rolls back even its first clip holds',
  );
  assert.equal((await repository.quote(quote.id)).consumedByJobId, null);
});

test('expired and stale quotes do not authorize production and legacy approvals require a new review', async (t) => {
  const { repository } = await storage(t);
  const { workflow, session, profile } = creation();
  await repository.create(session);
  const expired = await repository.addQuote(
    buildCreatorQuote(session, workflow, profile, [], new Date(Date.now() - 11 * 60_000)),
  );
  await assert.rejects(approve(repository, session, expired), { code: 'CREATOR_QUOTE_EXPIRED' });
  const fresh = await repository.addQuote(buildCreatorQuote(session, workflow, profile, []));
  const edited = await repository.update(session.id, session.version, (current) => ({
    ...current,
    input: { ...current.input, prompt: 'A changed direction' },
  }));
  await assert.rejects(approve(repository, edited, fresh), { code: 'CREATOR_QUOTE_STALE' });
  const legacy = {
    ...edited,
    approval: {
      id: randomUUID(),
      planId: edited.plan!.id,
      workflowVersion: workflow.version,
      approvedAt: new Date().toISOString(),
    },
  };
  await repository.update(edited.id, edited.version, () => legacy);
  await assert.rejects(repository.addJob(production(legacy), edited.version + 1), {
    code: 'CREATOR_QUOTE_REQUIRED',
  });
  assert.equal((await repository.budget()).reservedCents, 0);
});

test('pricebook and quote fingerprint bind prompts, source asset identity, duration, and provider', () => {
  const { workflow, session, profile } = creation();
  const original = quoteFingerprint(session, workflow, profile);
  const changed = structuredClone(session);
  changed.plan!.clips[0]!.prompt = 'A different approved camera composition.';
  assert.notEqual(quoteFingerprint(changed, workflow, profile), original);
  changed.plan!.clips[0]!.seconds = 4;
  assert.notEqual(quoteFingerprint(changed, workflow, profile), original);
  const fal = productionProfile({
    profile: {
      provider: 'fal',
      model: 'seedance-v1.5-pro',
      minSeconds: 4,
      maxSeconds: 10,
      rateCentsPerSecond: 1,
    },
  });
  assert.equal(
    fal.rateCentsPerSecond,
    5,
    'configured rates cannot undercut the conservative pricebook',
  );
  assert.notEqual(quoteFingerprint(session, workflow, fal), original);
  const falSession = structuredClone(session);
  falSession.plan!.provider = 'fal';
  falSession.plan!.model = 'seedance-v1.5-pro';
  assert.equal(buildCreatorQuote(falSession, workflow, fal, []).maxCostCents, 105);
  const asset = {
    id: randomUUID(),
    sha256: 'a'.repeat(64),
    bytes: 100,
    mimeType: 'image/png' as const,
    width: 100,
    height: 100,
    filename: 'cup.png',
    description: 'The reference cup.',
    createdAt: new Date().toISOString(),
  };
  const withAsset = { ...workflow, assets: [asset] };
  assert.notEqual(
    quoteFingerprint(session, withAsset, profile),
    quoteFingerprint(
      session,
      { ...withAsset, assets: [{ ...asset, sha256: 'b'.repeat(64) }] },
      profile,
    ),
  );
});

test('legacy production receipts with unknown past spend fail closed on first budget migration', async (t) => {
  const { file, repository } = await storage(t);
  const { session } = creation();
  await repository.create(session);
  const now = new Date().toISOString();
  const job = creatorJobSchema.parse({
    id: randomUUID(),
    requestId: randomUUID(),
    sessionId: session.id,
    kind: 'production',
    status: 'failed',
    phase: 'generating',
    sourceVersion: 1,
    workflowVersion: 1,
    approvalId: randomUUID(),
    clips: [
      {
        clipId: session.plan!.clips[0]!.id,
        attempt: 1,
        providerTaskId: 'legacy-task',
        status: 'generating',
        audit: null,
      },
    ],
    events: [],
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, sessions: [session], jobs: [job] }));
  const migrated = await CreatorRepository.open(file);
  assert.equal((await migrated.budget()).availableCents, 0);
  assert.equal((await migrated.budget()).reservedCents, 3000);
  assert.equal(
    (await (await CreatorRepository.open(file)).budget()).reservedCents,
    3000,
    'migration itself is idempotent',
  );
});
