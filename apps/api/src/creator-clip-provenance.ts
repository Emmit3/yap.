import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  creatorVideoModelSchema,
  creatorVideoProfileIdSchema,
  creatorVideoRatioSchema,
  type CreatorClip,
  type CreatorJob,
} from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import type { CreatorProductionProfile } from './creator-budget.js';
import { creatorVideoPrompt } from './creator-video-provider.js';
import { ApiError } from './errors.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const imageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('asset'),
      id: z.uuid(),
      sha256,
      bytes,
      mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    })
    .strict(),
  z.object({ kind: z.literal('storyboard'), id: z.uuid(), sha256 }).strict(),
]);
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.enum(['runway', 'fal']),
    model: creatorVideoModelSchema,
    videoProfileId: creatorVideoProfileIdSchema.nullable(),
    ratio: creatorVideoRatioSchema,
    nativeWidth: z.number().int().positive().max(3840),
    nativeHeight: z.number().int().positive().max(3840),
    seconds: z.number().int().min(2).max(10),
    prompt: z.string().min(1).max(1000),
    camera: z.string().min(1).max(1000),
    lighting: z.string().min(1).max(1000),
    providerPrompt: z.string().min(1).max(4000),
    referenceIds: z.array(z.string().min(1).max(120)).max(12),
    image: imageSchema.nullable(),
  })
  .strict();
export type ClipGenerationSnapshot = z.infer<typeof snapshotSchema>;

/** Creative inputs only: this does not assert a historical image preprocessing recipe. */
export function clipGenerationSnapshot(
  clip: CreatorClip,
  workflow: Workflow,
  profile: CreatorProductionProfile,
): ClipGenerationSnapshot {
  const selected = profile.clipProfiles?.[clip.id] ?? profile;
  if (clip.videoProfileId && selected.id && clip.videoProfileId !== selected.id)
    throw new ApiError(409, 'CREATOR_GENERATION_PROFILE', 'The selected clip profile changed.');
  if (clip.assetId && clip.storyboardFrameId)
    throw new ApiError(409, 'CREATOR_GENERATION_SOURCE', 'Choose one image source for this clip.');
  let image: ClipGenerationSnapshot['image'] = null;
  if (clip.assetId) {
    const asset = workflow.assets.find((value) => value.id === clip.assetId);
    if (!asset)
      throw new ApiError(
        409,
        'CREATOR_GENERATION_SOURCE_MISSING',
        'The clip photo is no longer available.',
      );
    image = {
      kind: 'asset',
      id: asset.id,
      sha256: asset.sha256,
      bytes: asset.bytes,
      mimeType: asset.mimeType,
    };
  } else if (clip.storyboardFrameId) {
    if (!clip.storyboardFrameSha256)
      throw new ApiError(
        409,
        'CREATOR_GENERATION_SOURCE_MISSING',
        'The storyboard source needs its verified image hash.',
      );
    image = { kind: 'storyboard', id: clip.storyboardFrameId, sha256: clip.storyboardFrameSha256 };
  } else if (clip.storyboardFrameSha256) {
    throw new ApiError(
      409,
      'CREATOR_GENERATION_SOURCE_MISSING',
      'The storyboard image identity is missing.',
    );
  }
  const ratio = selected.ratio ?? '720:1280';
  return snapshotSchema.parse({
    schemaVersion: 1,
    provider: selected.provider,
    model: selected.model,
    videoProfileId: selected.id ?? clip.videoProfileId ?? null,
    ratio,
    nativeWidth: selected.nativeWidth ?? (ratio === '1280:720' ? 1280 : 720),
    nativeHeight: selected.nativeHeight ?? (ratio === '1280:720' ? 720 : 1280),
    seconds: clip.seconds,
    prompt: clip.prompt,
    camera: clip.camera,
    lighting: clip.lighting,
    providerPrompt: creatorVideoPrompt(clip),
    referenceIds: [...(clip.referenceIds ?? [])],
    image,
  });
}

/** Parsing fixes key order and rejects unknown fields without normalizing creative text. */
export function clipGenerationFingerprint(snapshot: ClipGenerationSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(snapshotSchema.parse(snapshot)))
    .digest('hex');
}

export const clipProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.uuid(),
    jobId: z.uuid(),
    planId: z.uuid(),
    clipId: z.uuid(),
    attempt: z.number().int().min(1).max(2),
    output: z.object({ bytes, sha256 }).strict().nullable(),
    snapshot: snapshotSchema,
    fingerprint: sha256,
    kind: z.enum(['generated_input', 'generated', 'legacy_current_plan']),
    capturedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((proof, context) => {
    if (proof.kind === 'generated_input' && proof.output !== null)
      context.addIssue({
        code: 'custom',
        path: ['output'],
        message: 'Input provenance cannot assert output bytes.',
      });
    if (proof.kind === 'generated' && proof.output === null)
      context.addIssue({
        code: 'custom',
        path: ['output'],
        message: 'Generated output provenance needs its byte identity.',
      });
  });
export type ClipProvenance = z.infer<typeof clipProvenanceSchema>;

export function provenanceMatches(
  job: CreatorJob,
  receipt: CreatorJob['clips'][number],
  provenance: unknown,
  expectedFingerprint: string,
): boolean {
  const parsed = clipProvenanceSchema.safeParse(provenance);
  if (!parsed.success) return false;
  const proof = parsed.data;
  const output = proof.output;
  if (!output) return false;
  try {
    if (
      job.kind !== 'production' ||
      proof.jobId !== job.id ||
      proof.sessionId !== job.sessionId ||
      proof.planId !== job.planId ||
      proof.clipId !== receipt.clipId ||
      proof.attempt !== receipt.attempt ||
      proof.fingerprint !== expectedFingerprint ||
      clipGenerationFingerprint(proof.snapshot) !== proof.fingerprint
    )
      return false;
    const matchesReceipt = (value: CreatorJob['clips'][number]) =>
      value.status === 'passed' &&
      value.audit?.technicalPassed === true &&
      value.audit.visionPassed === true &&
      value.output?.bytes === output.bytes &&
      value.output.sha256 === output.sha256 &&
      (value.prompt === undefined || value.prompt === proof.snapshot.prompt) &&
      (value.provider === undefined || value.provider === proof.snapshot.provider) &&
      (value.model === undefined || value.model === proof.snapshot.model) &&
      (value.videoProfileId === undefined ||
        value.videoProfileId === proof.snapshot.videoProfileId) &&
      (value.ratio === undefined || value.ratio === proof.snapshot.ratio) &&
      (value.nativeWidth === undefined || value.nativeWidth === proof.snapshot.nativeWidth) &&
      (value.nativeHeight === undefined || value.nativeHeight === proof.snapshot.nativeHeight);
    const stored = job.clips.filter(
      (value) => value.clipId === receipt.clipId && value.attempt === receipt.attempt,
    );
    return stored.length === 1 && matchesReceipt(receipt) && matchesReceipt(stored[0]!);
  } catch {
    return false;
  }
}
