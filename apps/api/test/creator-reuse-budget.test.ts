import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  creatorJobSchema,
  creatorSessionSchema,
  type CreatorJob,
  type CreatorSession,
} from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import {
  buildCreatorQuote,
  productionProfile,
  quoteFingerprint,
  type CreatorProductionProfile,
} from '../src/creator-budget.js';
import {
  clipGenerationFingerprint,
  clipGenerationSnapshot,
  clipProvenanceSchema,
  provenanceMatches,
  type ClipProvenance,
} from '../src/creator-clip-provenance.js';
import { CreatorRepository } from '../src/creator-repository.js';
import { createWorkflow } from '../src/workflow-engine.js';

const now = new Date('2026-11-15T12:00:00.000Z');
const profile = productionProfile({
  profile: {
    provider: 'fal',
    model: 'seedance-2.5',
    id: 'fal-seedance2.5-portrait',
    ratio: '720:1280',
    nativeWidth: 720,
    nativeHeight: 1280,
    minSeconds: 4,
    maxSeconds: 10,
    requiresImage: true,
    rateCentsPerSecond: 50,
  },
});

function photo(character: string) {
  return {
    id: randomUUID(),
    filename: 'test-product.jpg',
    mimeType: 'image/jpeg' as const,
    bytes: 2048,
    width: 720,
    height: 1280,
    sha256: character.repeat(64),
    description: 'A creator-owned tea product photo.',
    createdAt: now.toISOString(),
  };
}

function original() {
  const workflow = createWorkflow({ input: 'A twenty-second tea film', brief: { duration: 20 } });
  workflow.assets = ['a', 'b', 'c', 'd'].map(photo);
  const session = creatorSessionSchema.parse({
    id: randomUUID(),
    version: 2,
    workflowId: workflow.id,
    input: { mode: 'media', prompt: 'A twenty-second tea film', urls: [] },
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
      caption: 'Tea, quietly considered.',
      provider: 'fal',
      model: 'seedance-2.5',
      ratio: '720:1280',
      hasAudio: false,
      maxAttemptsPerClip: 2,
      maxGeneratedSeconds: 40,
      createdAt: now.toISOString(),
      clips: workflow.assets.map((asset, index) => ({
        id: randomUUID(),
        sceneId: randomUUID(),
        seconds: 5,
        prompt: `Preserve the supplied tea product in composition ${index + 1}.`,
        camera: 'A slow, controlled push in.',
        lighting: 'Soft daylight and restrained highlights.',
        assetId: asset.id,
        videoProfileId: 'fal-seedance2.5-portrait',
      })),
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const job = creatorJobSchema.parse({
    id: randomUUID(),
    requestId: randomUUID(),
    sessionId: session.id,
    kind: 'production',
    status: 'failed',
    phase: 'generating',
    sourceVersion: session.version,
    workflowVersion: workflow.version,
    approvalId: randomUUID(),
    quoteId: randomUUID(),
    planId: session.plan!.id,
    clips: session.plan!.clips.map((clip, index) => ({
      clipId: clip.id,
      attempt: 1,
      providerTaskId: `test-provider-task-${index}`,
      status: index < 3 ? 'passed' : 'failed',
      audit:
        index < 3
          ? { technicalPassed: true, visionPassed: true, summary: 'Reviewed.', issues: [] }
          : null,
      prompt: clip.prompt,
      provider: 'fal',
      model: 'seedance-2.5',
      videoProfileId: 'fal-seedance2.5-portrait',
      ratio: '720:1280',
      nativeWidth: 720,
      nativeHeight: 1280,
      ...(index < 3 ? { output: { bytes: 4096, sha256: String(index + 1).repeat(64) } } : {}),
    })),
    events: [],
    output: null,
    error: { code: 'CREATOR_VIDEO_REJECTED', message: 'The final image was rejected.' },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const provenance = job.clips.map((receipt, index) => {
    const snapshot = clipGenerationSnapshot(session.plan!.clips[index]!, workflow, profile);
    return clipProvenanceSchema.parse({
      schemaVersion: 1,
      sessionId: session.id,
      jobId: job.id,
      planId: job.planId,
      clipId: receipt.clipId,
      attempt: receipt.attempt,
      output: receipt.output ?? null,
      snapshot,
      fingerprint: clipGenerationFingerprint(snapshot),
      kind: receipt.output ? 'legacy_current_plan' : 'generated_input',
      capturedAt: now.toISOString(),
    });
  });
  return { session, workflow, job, provenance };
}

function revised(value: ReturnType<typeof original>) {
  const session = structuredClone(value.session);
  const workflow = structuredClone(value.workflow);
  session.version++;
  session.plan!.id = randomUUID();
  session.plan!.scriptId = randomUUID();
  session.plan!.sourceScenesId = randomUUID();
  session.plan!.clips.forEach((clip) => (clip.sceneId = randomUUID()));
  workflow.version++;
  workflow.assets.push(photo('e'), photo('f'));
  session.plan!.clips[3]!.assetId = workflow.assets.at(-1)!.id;
  return { session, workflow };
}

function quote(
  value: { session: CreatorSession; workflow: Workflow },
  history: CreatorJob[],
  provenance: ClipProvenance[],
  selected: CreatorProductionProfile = profile,
) {
  return buildCreatorQuote(value.session, value.workflow, selected, history, now, 10, provenance);
}

test('a new twenty-second plan reuses three reviewed shots and quotes only the changed final photo at 260 cents', () => {
  const old = original();
  const next = revised(old);
  const before = structuredClone(old);
  assert.notEqual(
    quoteFingerprint(next.session, next.workflow, profile),
    quoteFingerprint(old.session, old.workflow, profile),
  );
  const result = quote(next, [old.job], old.provenance);
  assert.equal(result.planId, next.session.plan!.id);
  assert.equal(result.maxCostCents, 260);
  assert.equal(result.audioCents, 0);
  assert.deepEqual(
    result.clips.map(({ seconds, videoCents, visionCents, costCents, attempt }) => ({
      seconds,
      videoCents,
      visionCents,
      costCents,
      attempt,
    })),
    [
      { seconds: 5, videoCents: 0, visionCents: 0, costCents: 0, attempt: 1 },
      { seconds: 5, videoCents: 0, visionCents: 0, costCents: 0, attempt: 1 },
      { seconds: 5, videoCents: 0, visionCents: 0, costCents: 0, attempt: 1 },
      { seconds: 5, videoCents: 250, visionCents: 10, costCents: 260, attempt: 1 },
    ],
  );
  for (const [index, item] of result.clips.entries())
    assert.deepEqual(
      item.reuse,
      index < 3
        ? { jobId: old.job.id, attempt: 1, sha256: old.job.clips[index]!.output!.sha256 }
        : null,
    );
  assert.deepEqual(old, before, 'quoting must not rewrite historical generation evidence');
});

test('selecting the same effective default profile cannot renew unchanged failed attempts', () => {
  const old = original();
  delete old.session.plan!.clips[3]!.videoProfileId;
  delete old.job.clips[3]!.videoProfileId;
  old.job.clips.push({ ...old.job.clips[3]!, attempt: 2 });
  old.provenance.push({ ...old.provenance[3]!, attempt: 2 });
  const next = revised(old);
  next.session.plan!.clips[3]!.assetId = old.session.plan!.clips[3]!.assetId;
  next.session.plan!.clips[3]!.videoProfileId = 'fal-seedance2.5-portrait';
  assert.throws(() => quote(next, [old.job], old.provenance), {
    code: 'CREATOR_ATTEMPTS_EXHAUSTED',
  });
});

test('changing a shot identity or generation input prevents that shot from reusing old footage', async (t) => {
  type Revision = ReturnType<typeof revised>;
  const cases: Array<{
    name: string;
    change: (next: Revision, selected: CreatorProductionProfile) => void;
  }> = [
    { name: 'clip ID', change: ({ session }) => (session.plan!.clips[0]!.id = randomUUID()) },
    {
      name: 'visual prompt',
      change: ({ session }) => (session.plan!.clips[0]!.prompt += ' Steam rises in frame.'),
    },
    {
      name: 'camera instruction',
      change: ({ session }) => (session.plan!.clips[0]!.camera = 'A locked wide frame.'),
    },
    {
      name: 'lighting instruction',
      change: ({ session }) => (session.plan!.clips[0]!.lighting = 'Hard side light.'),
    },
    { name: 'duration', change: ({ session }) => (session.plan!.clips[0]!.seconds = 6) },
    {
      name: 'provider, model and profile',
      change: ({ session }, selected) => {
        const clip = session.plan!.clips[0]!;
        clip.videoProfileId = 'runway-gen4.5-portrait';
        selected.clipProfiles = {
          [clip.id]: {
            ...selected,
            id: 'runway-gen4.5-portrait',
            provider: 'runway',
            model: 'gen4.5',
            rateCentsPerSecond: 16,
            minSeconds: 2,
          },
        };
      },
    },
    {
      name: 'native aspect and dimensions',
      change: ({ session }, selected) => {
        const clip = session.plan!.clips[0]!;
        clip.videoProfileId = 'fal-seedance2.5-landscape';
        selected.clipProfiles = {
          [clip.id]: {
            ...selected,
            id: 'fal-seedance2.5-landscape',
            ratio: '1280:720',
            nativeWidth: 1280,
            nativeHeight: 720,
          },
        };
      },
    },
    {
      name: 'selected photo',
      change: ({ session, workflow }) => (session.plan!.clips[0]!.assetId = workflow.assets[1]!.id),
    },
    {
      name: 'selected photo content hash',
      change: ({ workflow }) => (workflow.assets[0]!.sha256 = 'f'.repeat(64)),
    },
    { name: 'selected photo byte count', change: ({ workflow }) => workflow.assets[0]!.bytes++ },
    {
      name: 'selected photo media type',
      change: ({ workflow }) => (workflow.assets[0]!.mimeType = 'image/png'),
    },
    {
      name: 'storyboard source',
      change: ({ session }) => {
        const clip = session.plan!.clips[0]!;
        delete clip.assetId;
        clip.storyboardFrameId = randomUUID();
        clip.storyboardFrameSha256 = 'a'.repeat(64);
      },
    },
  ];
  for (const { name, change } of cases)
    await t.test(name, () => {
      const old = original();
      const next = revised(old);
      const selected = structuredClone(profile);
      change(next, selected);
      const result = quote(next, [old.job], old.provenance, selected);
      assert.equal(result.clips[0]!.reuse, null);
      assert.ok(result.clips[0]!.costCents > 0);
      assert.equal(result.clips.filter((clip) => clip.reuse).length, 2);
    });
});

test('an unchanged failed input cannot reset its two attempts by creating another plan', () => {
  const old = original();
  const failedClip = old.job.clips[3]!;
  const second = structuredClone(old.job);
  second.id = randomUUID();
  second.planId = randomUUID();
  second.requestId = randomUUID();
  second.clips = [{ ...failedClip, attempt: 2 }];
  const proof = clipProvenanceSchema.parse({
    ...old.provenance[3]!,
    jobId: second.id,
    planId: second.planId,
    attempt: 2,
  });
  const next = revised(old);
  next.session.plan!.clips[3]!.assetId = old.session.plan!.clips[3]!.assetId;
  assert.throws(() => quote(next, [old.job, second], [...old.provenance, proof]), {
    code: 'CREATOR_ATTEMPTS_EXHAUSTED',
  });
  const changed = revised(old);
  const result = quote(changed, [old.job, second], [...old.provenance, proof]);
  assert.equal(result.maxCostCents, 260);
  assert.equal(
    result.clips[3]!.attempt,
    1,
    'a genuinely different image is a different paid input',
  );
});

test('cross-plan reuse requires matching immutable provenance and successful technical and visual review', async (t) => {
  const cases: Array<{
    name: string;
    change: (old: ReturnType<typeof original>) => void;
  }> = [
    { name: 'missing provenance', change: (old) => (old.provenance = old.provenance.slice(1)) },
    {
      name: 'missing output provenance',
      change: (old) => {
        old.provenance[0]!.kind = 'generated_input';
        old.provenance[0]!.output = null;
      },
    },
    { name: 'wrong session', change: (old) => (old.provenance[0]!.sessionId = randomUUID()) },
    { name: 'wrong job', change: (old) => (old.provenance[0]!.jobId = randomUUID()) },
    { name: 'wrong plan', change: (old) => (old.provenance[0]!.planId = randomUUID()) },
    { name: 'wrong attempt', change: (old) => (old.provenance[0]!.attempt = 2) },
    {
      name: 'wrong output hash',
      change: (old) => (old.provenance[0]!.output!.sha256 = 'f'.repeat(64)),
    },
    { name: 'wrong output bytes', change: (old) => old.provenance[0]!.output!.bytes++ },
    {
      name: 'tampered snapshot with unchanged fingerprint',
      change: (old) => (old.provenance[0]!.snapshot.camera = 'An unapproved camera move.'),
    },
    {
      name: 'failed technical review',
      change: (old) => (old.job.clips[0]!.audit!.technicalPassed = false),
    },
    {
      name: 'failed visual review',
      change: (old) => (old.job.clips[0]!.audit!.visionPassed = false),
    },
    {
      name: 'unavailable visual review',
      change: (old) => (old.job.clips[0]!.audit!.visionPassed = null),
    },
    { name: 'failed receipt', change: (old) => (old.job.clips[0]!.status = 'failed') },
    {
      name: 'ambiguous duplicate receipt',
      change: (old) => old.job.clips.push(structuredClone(old.job.clips[0]!)),
    },
  ];
  for (const { name, change } of cases)
    await t.test(name, () => {
      const old = original();
      change(old);
      const result = quote(revised(old), [old.job], old.provenance);
      assert.equal(result.clips[0]!.reuse, null);
      assert.equal(result.clips[0]!.costCents, 260);
      assert.equal(result.maxCostCents, 520);
    });
});

test('generation fingerprints retain exact creative text and verified storyboard identity', () => {
  const old = original();
  const clip = structuredClone(old.session.plan!.clips[0]!);
  delete clip.assetId;
  clip.storyboardFrameId = randomUUID();
  clip.storyboardFrameSha256 = 'a'.repeat(64);
  const first = clipGenerationSnapshot(clip, old.workflow, profile);
  clip.storyboardFrameSha256 = 'b'.repeat(64);
  assert.notEqual(
    clipGenerationFingerprint(clipGenerationSnapshot(clip, old.workflow, profile)),
    clipGenerationFingerprint(first),
  );
  clip.storyboardFrameSha256 = first.image!.sha256;
  clip.camera += ' ';
  assert.notEqual(
    clipGenerationFingerprint(clipGenerationSnapshot(clip, old.workflow, profile)),
    clipGenerationFingerprint(first),
    'creative instructions must not be trimmed into an old approval',
  );
  delete clip.storyboardFrameSha256;
  assert.throws(() => clipGenerationSnapshot(clip, old.workflow, profile), {
    code: 'CREATOR_GENERATION_SOURCE_MISSING',
  });
});

test('append-only provenance survives restart without relabeling jobs, consuming quotes or resetting shared spend', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yap-reuse-provenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'creator.json');
  const old = original();
  const reservations = old.job.clips.map((receipt, index) => {
    const reservation = {
      id: randomUUID(),
      idempotencyKey: `${old.job.id}:${receipt.clipId}`,
      category: 'video' as const,
      sourceId: `${old.job.id}:${receipt.clipId}`,
      amountCents: 260,
      chargedCents: index < 3 ? 260 : 0,
      createdAt: now.toISOString(),
    };
    receipt.reservationId = reservation.id;
    return reservation;
  });
  old.job.reservationIds = reservations.map(({ id }) => id);
  old.session.approval = {
    id: old.job.approvalId!,
    quoteId: old.job.quoteId,
    planId: old.job.planId!,
    workflowVersion: old.workflow.version,
    approvedAt: now.toISOString(),
  };
  const consumedQuote = buildCreatorQuote(old.session, old.workflow, profile, [], now);
  consumedQuote.id = old.job.quoteId!;
  consumedQuote.sessionVersion = old.session.version - 1;
  consumedQuote.approvedApprovalId = old.job.approvalId;
  consumedQuote.consumedByJobId = old.job.id;
  const budget = {
    limitCents: 3000,
    reservations: [
      ...reservations,
      {
        id: randomUUID(),
        idempotencyKey: 'uncertain-research-request',
        category: 'research',
        sourceId: 'public-research',
        amountCents: 60,
        chargedCents: null,
        createdAt: now.toISOString(),
      },
    ],
  };
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      sessions: [old.session],
      jobs: [old.job],
      quotes: [consumedQuote],
      budget,
    }),
  );
  const repository = await CreatorRepository.open(file);
  const beforeBudget = await repository.budget();
  assert.deepEqual(beforeBudget, {
    scope: 'creator_app',
    currency: 'USD',
    limitCents: 3000,
    chargedCents: 780,
    reservedCents: 60,
    availableCents: 2160,
  });
  for (const proof of old.provenance) await repository.recordClipProvenance(proof);
  const first = old.provenance[0]!;
  const duplicate = await repository.recordClipProvenance({
    ...first,
    capturedAt: new Date(now.getTime() + 1000).toISOString(),
  });
  assert.deepEqual(duplicate, first, 'duplicate capture returns the original immutable record');
  assert.equal((await repository.clipProvenance(old.session.id)).length, 4);
  const input = clipProvenanceSchema.parse({ ...first, kind: 'generated_input', output: null });
  await repository.recordClipProvenance(input);
  assert.equal((await repository.clipProvenance(old.session.id)).length, 5);
  const conflicting = structuredClone(first);
  conflicting.snapshot.camera = 'An entirely different camera instruction.';
  conflicting.fingerprint = clipGenerationFingerprint(conflicting.snapshot);
  await assert.rejects(repository.recordClipProvenance(conflicting), {
    code: 'CREATOR_PROVENANCE_CONFLICT',
  });
  await assert.rejects(
    repository.recordClipProvenance({
      ...first,
      output: { ...first.output!, sha256: 'f'.repeat(64) },
    }),
    { code: 'CREATOR_PROVENANCE_INVALID' },
  );
  const restarted = await CreatorRepository.open(file);
  const records = await restarted.clipProvenance(old.session.id);
  assert.equal(records.length, 5);
  assert.deepEqual(await restarted.budget(), beforeBudget);
  assert.deepEqual(await restarted.job(old.session.id, old.job.id), old.job);
  assert.deepEqual(await restarted.get(old.session.id), old.session);
  assert.deepEqual(await restarted.quote(consumedQuote.id), consumedQuote);
  assert.equal(
    quote(revised(old), await restarted.jobs(old.session.id), records).maxCostCents,
    260,
  );
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.budget, budget, 'attestation cannot refund or rewrite a reservation');
  assert.deepEqual(saved.jobs, [old.job]);
  assert.deepEqual(saved.quotes, [consumedQuote]);
  records[0]!.snapshot.camera = 'A caller mutation must not mutate durable provenance.';
  assert.deepEqual((await restarted.clipProvenance(old.session.id))[0], first);
});

test('provenance distinguishes captured inputs from actual reviewed output bytes', () => {
  const old = original();
  const proof = old.provenance[0]!;
  assert.equal(
    clipProvenanceSchema.safeParse({ ...proof, kind: 'generated', output: null }).success,
    false,
  );
  assert.equal(
    clipProvenanceSchema.safeParse({ ...proof, kind: 'generated_input' }).success,
    false,
  );
  assert.equal(provenanceMatches(old.job, old.job.clips[0]!, proof, proof.fingerprint), true);
  const input = clipProvenanceSchema.parse({ ...proof, kind: 'generated_input', output: null });
  assert.equal(provenanceMatches(old.job, old.job.clips[0]!, input, proof.fingerprint), false);
});
