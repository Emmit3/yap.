import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { creatorClipSchema, creatorJobSchema } from '@yap/contracts/creator';
import { workflowSchema } from '@yap/contracts/workflow';
import type { CreatorProductionProfile } from '../src/creator-budget.js';
import {
  clipGenerationFingerprint,
  clipGenerationSnapshot,
  clipProvenanceSchema,
  provenanceMatches,
} from '../src/creator-clip-provenance.js';
import { creatorVideoPrompt } from '../src/creator-video-provider.js';

function fixture() {
  const at = '2026-11-15T12:00:00.000Z';
  const workflow = workflowSchema.parse({
    id: randomUUID(),
    version: 1,
    contentRevision: 1,
    title: 'Ceramic cup',
    input: 'A ceramic cup.',
    brief: {},
    assets: [
      {
        id: randomUUID(),
        filename: 'cup.jpg',
        mimeType: 'image/jpeg',
        bytes: 1234,
        width: 800,
        height: 800,
        sha256: 'a'.repeat(64),
        description: 'A handmade ceramic cup.',
        createdAt: at,
      },
    ],
    messages: [],
    questions: [],
    script: null,
    scenes: null,
    approvals: { brief: null, script: null, scenes: null },
    createdAt: at,
    updatedAt: at,
  });
  const clip = creatorClipSchema.parse({
    id: randomUUID(),
    sceneId: randomUUID(),
    seconds: 5,
    prompt: 'Preserve the supplied ceramic cup.',
    camera: 'Slow push in.',
    lighting: 'Soft studio light.',
    assetId: workflow.assets[0]!.id,
    referenceIds: ['macro-study'],
  });
  const profile: CreatorProductionProfile = {
    provider: 'runway',
    model: 'gen4.5',
    id: 'runway-gen4.5-portrait',
    ratio: '720:1280',
    nativeWidth: 720,
    nativeHeight: 1280,
    minSeconds: 2,
    maxSeconds: 10,
    rateCentsPerSecond: 16,
  };
  const snapshot = clipGenerationSnapshot(clip, workflow, profile);
  const fingerprint = clipGenerationFingerprint(snapshot);
  const job = creatorJobSchema.parse({
    id: randomUUID(),
    requestId: randomUUID(),
    sessionId: randomUUID(),
    planId: randomUUID(),
    kind: 'production',
    status: 'failed',
    phase: 'generating',
    sourceVersion: 1,
    workflowVersion: 1,
    approvalId: randomUUID(),
    clips: [
      {
        clipId: clip.id,
        attempt: 1,
        providerTaskId: randomUUID(),
        status: 'passed',
        prompt: clip.prompt,
        provider: profile.provider,
        model: profile.model,
        videoProfileId: profile.id,
        ratio: profile.ratio,
        nativeWidth: profile.nativeWidth,
        nativeHeight: profile.nativeHeight,
        audit: {
          technicalPassed: true,
          visionPassed: true,
          summary: 'Decoded and reviewed.',
          issues: [],
        },
        output: { bytes: 4567, sha256: 'b'.repeat(64) },
      },
    ],
    events: [],
    output: null,
    error: { code: 'LATER_CLIP_FAILED', message: 'A later clip failed.' },
    createdAt: at,
    updatedAt: at,
  });
  const receipt = job.clips[0]!;
  const provenance = clipProvenanceSchema.parse({
    schemaVersion: 1,
    sessionId: job.sessionId,
    jobId: job.id,
    planId: job.planId,
    clipId: clip.id,
    attempt: 1,
    output: receipt.output,
    snapshot,
    fingerprint,
    kind: 'legacy_current_plan',
    capturedAt: at,
  });
  return { workflow, clip, profile, snapshot, fingerprint, job, receipt, provenance };
}

test('snapshots record creative input identity and the exact final provider prompt', () => {
  const { clip, workflow, snapshot } = fixture();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.providerPrompt, creatorVideoPrompt(clip));
  assert.deepEqual(snapshot.referenceIds, ['macro-study']);
  assert.deepEqual(snapshot.image, {
    kind: 'asset',
    id: workflow.assets[0]!.id,
    sha256: 'a'.repeat(64),
    bytes: 1234,
    mimeType: 'image/jpeg',
  });
  assert.equal('clipId' in snapshot, false);
  assert.equal('sceneId' in snapshot, false);
  assert.equal('preprocessingRevision' in snapshot, false);
  clip.referenceIds!.push('later-reference');
  assert.deepEqual(snapshot.referenceIds, ['macro-study']);
});

test('prompt, camera, lighting, duration and reference changes each change generation identity', () => {
  const { clip, workflow, profile, fingerprint } = fixture();
  for (const changed of [
    { ...clip, prompt: 'A different product direction.' },
    { ...clip, camera: 'Locked camera.' },
    { ...clip, lighting: 'Hard edge light.' },
    { ...clip, seconds: 6 },
    { ...clip, referenceIds: ['another-reference'] },
  ])
    assert.notEqual(
      clipGenerationFingerprint(clipGenerationSnapshot(changed, workflow, profile)),
      fingerprint,
    );
});

test('selected provider profile and its native geometry are part of the snapshot', () => {
  const { clip, workflow, profile, fingerprint } = fixture();
  const selected: CreatorProductionProfile = {
    ...profile,
    clipProfiles: {
      [clip.id]: {
        ...profile,
        provider: 'fal',
        model: 'seedance-2.5',
        id: 'fal-seedance2.5-landscape',
        ratio: '1280:720',
        nativeWidth: 1280,
        nativeHeight: 720,
      },
    },
  };
  const snapshot = clipGenerationSnapshot(clip, workflow, selected);
  assert.equal(snapshot.provider, 'fal');
  assert.equal(snapshot.model, 'seedance-2.5');
  assert.equal(snapshot.videoProfileId, 'fal-seedance2.5-landscape');
  assert.equal(snapshot.nativeWidth, 1280);
  assert.notEqual(clipGenerationFingerprint(snapshot), fingerprint);
  assert.throws(
    () =>
      clipGenerationSnapshot(
        { ...clip, videoProfileId: 'runway-gen4.5-portrait' },
        workflow,
        selected,
      ),
    /profile changed/,
  );
});

test('structural IDs, plan metadata, prices and unrelated photos do not change a clip identity', () => {
  const { clip, workflow, profile, fingerprint } = fixture();
  const unrelated = { ...workflow.assets[0]!, id: randomUUID(), sha256: 'c'.repeat(64) };
  const changedWorkflow = {
    ...workflow,
    version: 99,
    title: 'New plan title',
    assets: [...workflow.assets, unrelated],
    script: null,
    scenes: null,
  };
  const changedProfile = {
    ...profile,
    rateCentsPerSecond: 999,
    pricingCheckedAt: 'later',
    retired: true,
  };
  assert.equal(
    clipGenerationFingerprint(
      clipGenerationSnapshot(
        { ...clip, id: randomUUID(), sceneId: randomUUID() },
        changedWorkflow,
        changedProfile,
      ),
    ),
    fingerprint,
  );
});

test('asset identity, bytes, MIME type or hash changes invalidate reuse', () => {
  const { clip, workflow, profile, fingerprint } = fixture();
  const asset = workflow.assets[0]!;
  for (const changed of [
    { ...asset, sha256: 'd'.repeat(64) },
    { ...asset, bytes: 4321 },
    { ...asset, mimeType: 'image/png' as const },
  ]) {
    assert.notEqual(
      clipGenerationFingerprint(
        clipGenerationSnapshot(clip, { ...workflow, assets: [changed] }, profile),
      ),
      fingerprint,
    );
  }
  const different = { ...asset, id: randomUUID() };
  assert.notEqual(
    clipGenerationFingerprint(
      clipGenerationSnapshot(
        { ...clip, assetId: different.id },
        { ...workflow, assets: [different] },
        profile,
      ),
    ),
    fingerprint,
  );
  assert.throws(
    () => clipGenerationSnapshot(clip, { ...workflow, assets: [] }, profile),
    /no longer available/,
  );
});

test('storyboard snapshots require a single explicit image identity and hash', () => {
  const { clip, workflow, profile } = fixture();
  const { assetId: _assetId, ...textClip } = clip;
  assert.equal(clipGenerationSnapshot(textClip, workflow, profile).image, null);
  const frame = {
    ...textClip,
    storyboardFrameId: randomUUID(),
    storyboardFrameSha256: 'e'.repeat(64),
  };
  const snapshot = clipGenerationSnapshot(frame, workflow, profile);
  assert.deepEqual(snapshot.image, {
    kind: 'storyboard',
    id: frame.storyboardFrameId,
    sha256: frame.storyboardFrameSha256,
  });
  assert.notEqual(
    clipGenerationFingerprint(snapshot),
    clipGenerationFingerprint(
      clipGenerationSnapshot(
        { ...frame, storyboardFrameSha256: 'f'.repeat(64) },
        workflow,
        profile,
      ),
    ),
  );
  assert.throws(
    () =>
      clipGenerationSnapshot({ ...textClip, storyboardFrameId: randomUUID() }, workflow, profile),
    /verified image hash/,
  );
  assert.throws(
    () =>
      clipGenerationSnapshot(
        { ...textClip, storyboardFrameSha256: 'e'.repeat(64) },
        workflow,
        profile,
      ),
    /identity is missing/,
  );
  assert.throws(
    () => clipGenerationSnapshot({ ...clip, storyboardFrameId: randomUUID() }, workflow, profile),
    /one image source/,
  );
});

test('fingerprints are stable under object key order and preserve exact creative text', () => {
  const { snapshot, fingerprint } = fixture();
  const { image, ...rest } = snapshot;
  assert.equal(clipGenerationFingerprint({ image, ...rest }), fingerprint);
  assert.notEqual(
    clipGenerationFingerprint({ ...snapshot, prompt: `${snapshot.prompt} ` }),
    fingerprint,
  );
});

test('a passed clip in a partially failed job can match verified legacy or new provenance', () => {
  const { job, receipt, provenance, fingerprint } = fixture();
  assert.equal(provenanceMatches(job, receipt, provenance, fingerprint), true);
  assert.equal(
    provenanceMatches(job, receipt, { ...provenance, kind: 'generated' }, fingerprint),
    true,
  );
});

test('input-only provenance retains intent without claiming reusable output or resetting paid history', () => {
  const { job, receipt, provenance, fingerprint } = fixture();
  for (const kind of ['generated_input', 'legacy_current_plan'] as const) {
    const input = clipProvenanceSchema.parse({ ...provenance, kind, output: null });
    assert.equal(input.fingerprint, fingerprint);
    assert.equal(provenanceMatches(job, receipt, input, fingerprint), false);
  }
  assert.equal(
    clipProvenanceSchema.safeParse({ ...provenance, kind: 'generated_input' }).success,
    false,
  );
  assert.equal(
    clipProvenanceSchema.safeParse({ ...provenance, kind: 'generated', output: null }).success,
    false,
  );
});

test('foreign identities, attempts, missing plan identity and output corruption are rejected', () => {
  const { job, receipt, provenance, fingerprint } = fixture();
  for (const changed of [
    { ...provenance, sessionId: randomUUID() },
    { ...provenance, jobId: randomUUID() },
    { ...provenance, planId: randomUUID() },
    { ...provenance, clipId: randomUUID() },
    { ...provenance, attempt: 2 },
    { ...provenance, output: { ...provenance.output, bytes: 99 } },
    { ...provenance, output: { ...provenance.output, sha256: 'c'.repeat(64) } },
  ])
    assert.equal(provenanceMatches(job, receipt, changed, fingerprint), false);
  assert.equal(
    provenanceMatches({ ...job, planId: undefined }, receipt, provenance, fingerprint),
    false,
  );
  assert.equal(provenanceMatches({ ...job, clips: [] }, receipt, provenance, fingerprint), false);
  assert.equal(
    provenanceMatches({ ...job, clips: [receipt, receipt] }, receipt, provenance, fingerprint),
    false,
  );
});

test('strict provenance validation and snapshot rehash reject malformed or forged proofs', () => {
  const { job, receipt, provenance, fingerprint } = fixture();
  for (const changed of [
    null,
    [],
    { ...provenance, unexpected: true },
    { ...provenance, fingerprint: 'f'.repeat(64) },
    { ...provenance, snapshot: { ...provenance.snapshot, lighting: 'Changed after generation.' } },
  ]) {
    assert.equal(provenanceMatches(job, receipt, changed, fingerprint), false);
  }
  const forged = {
    ...provenance,
    snapshot: { ...provenance.snapshot, camera: 'Different camera.' },
  };
  forged.fingerprint = clipGenerationFingerprint(forged.snapshot);
  assert.equal(provenanceMatches(job, receipt, forged, fingerprint), false);
  assert.equal(
    clipProvenanceSchema.safeParse({
      ...provenance,
      snapshot: { ...provenance.snapshot, preprocessingRevision: 'invented' },
    }).success,
    false,
  );
});

test('failed, missing or incomplete audit evidence never matches', () => {
  const { job, receipt, provenance, fingerprint } = fixture();
  assert.ok(receipt.audit);
  for (const changed of [
    { ...receipt, status: 'failed' as const },
    { ...receipt, audit: null },
    { ...receipt, audit: { ...receipt.audit, technicalPassed: false } },
    { ...receipt, audit: { ...receipt.audit, visionPassed: null } },
  ]) {
    assert.equal(
      provenanceMatches({ ...job, clips: [changed] }, changed, provenance, fingerprint),
      false,
    );
  }
});

test('receipt prompt and optional provider/profile fields must agree with the proof', () => {
  const { job, receipt, provenance, fingerprint } = fixture();
  for (const changed of [
    { ...receipt, prompt: 'A foreign prompt.' },
    { ...receipt, provider: 'fal' as const },
    { ...receipt, model: 'gen4_turbo' as const },
    { ...receipt, videoProfileId: 'runway-gen4turbo-portrait' as const },
    { ...receipt, ratio: '1280:720' as const },
    { ...receipt, nativeWidth: 1280 },
    { ...receipt, nativeHeight: 720 },
  ])
    assert.equal(
      provenanceMatches({ ...job, clips: [changed] }, changed, provenance, fingerprint),
      false,
    );
  const {
    prompt: _prompt,
    provider: _provider,
    model: _model,
    videoProfileId: _profile,
    ratio: _ratio,
    nativeWidth: _width,
    nativeHeight: _height,
    ...legacy
  } = receipt;
  assert.equal(
    provenanceMatches({ ...job, clips: [legacy] }, legacy, provenance, fingerprint),
    true,
  );
  assert.equal(
    provenanceMatches(
      { ...job, clips: [{ ...receipt, provider: 'fal' }] },
      legacy,
      provenance,
      fingerprint,
    ),
    false,
  );
  const foreignSnapshot = {
    ...provenance.snapshot,
    model: 'gen4_turbo' as const,
    videoProfileId: 'runway-gen4turbo-portrait' as const,
  };
  const foreignFingerprint = clipGenerationFingerprint(foreignSnapshot);
  assert.equal(
    provenanceMatches(
      job,
      receipt,
      { ...provenance, snapshot: foreignSnapshot, fingerprint: foreignFingerprint },
      foreignFingerprint,
    ),
    false,
  );
});
