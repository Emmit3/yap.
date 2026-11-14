import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  CreatorSession,
  CreatorJob,
  CreatorQuote,
  CreatorBudgetSnapshot,
} from '@yap/contracts/creator';
import { creatorQuoteSchema } from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import { creatorVideoPrompt } from './creator-video-provider.js';
import { ApiError } from './errors.js';

export const CREATOR_BUDGET_LIMIT_CENTS = 3000;
export const creatorReservationSchema = z
  .object({
    id: z.uuid(),
    idempotencyKey: z.string().min(1).max(300),
    category: z.enum(['video', 'vision', 'research', 'drafting']),
    sourceId: z.string().min(1).max(300),
    amountCents: z.number().int().positive().max(3000),
    chargedCents: z.number().int().nonnegative().max(3000).nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const creatorBudgetStateSchema = z
  .object({
    limitCents: z.number().int().positive().max(CREATOR_BUDGET_LIMIT_CENTS),
    reservations: z.array(creatorReservationSchema).max(20000),
  })
  .strict();
export type CreatorBudgetState = z.infer<typeof creatorBudgetStateSchema>;
export type CreatorReservation = z.infer<typeof creatorReservationSchema>;
export type CreatorReservationInput = Pick<
  CreatorReservation,
  'idempotencyKey' | 'category' | 'sourceId' | 'amountCents'
>;
/** Reserve before a billable call; settle only a known charge. Unknown outcomes retain the full hold. */
export interface CreatorBudgetLedger {
  budget(): Promise<CreatorBudgetSnapshot>;
  reserve(input: CreatorReservationInput): Promise<CreatorReservation>;
  settle(reservationId: string, chargedCents: number): Promise<CreatorReservation>;
}
export function budgetSnapshot(state: CreatorBudgetState): CreatorBudgetSnapshot {
  const reservedCents = state.reservations.reduce(
    (sum, item) => sum + (item.chargedCents === null ? item.amountCents : 0),
    0,
  );
  const chargedCents = state.reservations.reduce((sum, item) => sum + (item.chargedCents ?? 0), 0);
  return {
    scope: 'creator_app',
    currency: 'USD',
    limitCents: state.limitCents,
    reservedCents,
    chargedCents,
    availableCents: Math.max(0, state.limitCents - reservedCents - chargedCents),
  };
}
export function reserveBudget(
  state: CreatorBudgetState,
  input: CreatorReservationInput,
): CreatorReservation {
  const previous = state.reservations.find((item) => item.idempotencyKey === input.idempotencyKey);
  if (previous) {
    if (
      previous.amountCents !== input.amountCents ||
      previous.category !== input.category ||
      previous.sourceId !== input.sourceId
    )
      throw new ApiError(
        409,
        'CREATOR_BUDGET_REQUEST_CONFLICT',
        'This spending request belongs to a different operation.',
      );
    return previous;
  }
  if (input.amountCents > budgetSnapshot(state).availableCents)
    throw new ApiError(
      409,
      'CREATOR_BUDGET_EXCEEDED',
      'This request exceeds the remaining creator budget. No paid call was started.',
    );
  const reservation = creatorReservationSchema.parse({
    ...input,
    id: randomUUID(),
    chargedCents: null,
    createdAt: new Date().toISOString(),
  });
  state.reservations.push(reservation);
  return reservation;
}
export function settleBudget(
  state: CreatorBudgetState,
  reservationId: string,
  chargedCents: number,
): CreatorReservation {
  const item = state.reservations.find((value) => value.id === reservationId);
  if (!item)
    throw new ApiError(
      404,
      'CREATOR_RESERVATION_NOT_FOUND',
      'This spending reservation was not found.',
    );
  if (!Number.isInteger(chargedCents) || chargedCents < 0 || chargedCents > item.amountCents)
    throw new ApiError(
      400,
      'CREATOR_CHARGE_INVALID',
      'The known charge must be within its reserved ceiling.',
    );
  if (item.chargedCents !== null && item.chargedCents !== chargedCents)
    throw new ApiError(
      409,
      'CREATOR_CHARGE_SETTLED',
      'This spending reservation has already been settled.',
    );
  item.chargedCents = chargedCents;
  return item;
}
const profileSchema = z
  .object({
    provider: z.enum(['runway', 'fal']),
    model: z.enum(['gen4.5', 'seedance-v1.5-pro']),
    minSeconds: z.number().int().min(2).max(10),
    maxSeconds: z.number().int().min(2).max(10),
    rateCentsPerSecond: z.number().int().positive().max(1000),
    priceSourceUrl: z.string().optional(),
    pricingCheckedAt: z.string().optional(),
  })
  .strict();
export type CreatorProductionProfile = z.infer<typeof profileSchema>;
export function productionProfile(video: object): CreatorProductionProfile {
  const profile = profileSchema.parse(
    ('profile' in video ? video.profile : undefined) ?? {
      provider: 'runway',
      model: 'gen4.5',
      minSeconds: 2,
      maxSeconds: 10,
      rateCentsPerSecond: 16,
    },
  );
  if (
    (profile.provider === 'fal' &&
      (profile.model !== 'seedance-v1.5-pro' || profile.minSeconds < 4)) ||
    (profile.provider === 'runway' && profile.model !== 'gen4.5') ||
    profile.maxSeconds < profile.minSeconds
  )
    throw new ApiError(
      503,
      'CREATOR_PRICEBOOK_INVALID',
      'The production provider profile is inconsistent.',
    );
  return {
    ...profile,
    rateCentsPerSecond: Math.max(profile.rateCentsPerSecond, profile.provider === 'fal' ? 5 : 16),
  };
}
export function quoteFingerprint(
  session: CreatorSession,
  workflow: Workflow,
  profile: CreatorProductionProfile,
): string {
  const plan = session.plan;
  return createHash('sha256')
    .update(
      JSON.stringify({
        planId: plan?.id,
        scriptId: plan?.scriptId,
        sourceScenesId: plan?.sourceScenesId,
        caption: plan?.caption,
        provider: profile.provider,
        model: profile.model,
        ratio: '720:1280',
        hasAudio: false,
        profile,
        clips: plan?.clips.map((clip) => ({ ...clip, providerPrompt: creatorVideoPrompt(clip) })),
        assets: workflow.assets.map(({ id, sha256, bytes, mimeType, description }) => ({
          id,
          sha256,
          bytes,
          mimeType,
          description,
        })),
      }),
    )
    .digest('hex');
}
export function planHistory(jobs: CreatorJob[], session: CreatorSession): CreatorJob[] {
  return jobs.filter(
    (job) =>
      job.kind === 'production' &&
      (job.planId === session.plan?.id ||
        (!job.planId && job.approvalId !== null && job.approvalId === session.approval?.id)),
  );
}
export function buildCreatorQuote(
  session: CreatorSession,
  workflow: Workflow,
  profile: CreatorProductionProfile,
  history: CreatorJob[],
  now = new Date(),
  visionCentsPerClip = 10,
): CreatorQuote {
  const plan = session.plan;
  if (!plan || plan.model !== profile.model || (plan.provider ?? 'runway') !== profile.provider)
    throw new ApiError(
      409,
      'CREATOR_PROVIDER_CHANGED',
      'Prepare a new plan for the configured production provider.',
    );
  const jobs = planHistory(history, session);
  const clips = plan.clips.map((clip) => {
    if (clip.seconds < profile.minSeconds || clip.seconds > profile.maxSeconds)
      throw new ApiError(
        400,
        'CREATOR_CLIP_DURATION',
        `This provider supports clips from ${profile.minSeconds} to ${profile.maxSeconds} seconds.`,
      );
    const previous = jobs.flatMap((job) =>
      job.clips
        .filter((receipt) => receipt.clipId === clip.id)
        .map((receipt) => ({ job, receipt })),
    );
    const passed = previous.find(({ receipt }) => receipt.status === 'passed' && receipt.output);
    if (passed)
      return {
        clipId: clip.id,
        seconds: clip.seconds,
        attempt: passed.receipt.attempt,
        videoCents: 0,
        visionCents: 0,
        costCents: 0,
        reuse: {
          jobId: passed.job.id,
          attempt: passed.receipt.attempt,
          sha256: passed.receipt.output!.sha256,
        },
      };
    const attempt = Math.max(0, ...previous.map(({ receipt }) => receipt.attempt)) + 1;
    if (attempt > plan.maxAttemptsPerClip)
      throw new ApiError(
        409,
        'CREATOR_ATTEMPTS_EXHAUSTED',
        'This plan has used both paid attempts for a clip. Edit and explicitly review a new plan before further generation.',
      );
    const videoCents = clip.seconds * profile.rateCentsPerSecond;
    return {
      clipId: clip.id,
      seconds: clip.seconds,
      attempt,
      videoCents,
      visionCents: visionCentsPerClip,
      costCents: videoCents + visionCentsPerClip,
      reuse: null,
    };
  });
  return creatorQuoteSchema.parse({
    estimateKind: 'conservative_ceiling',
    id: randomUUID(),
    sessionId: session.id,
    sessionVersion: session.version,
    workflowVersion: workflow.version,
    planId: plan.id,
    fingerprint: quoteFingerprint(session, workflow, profile),
    provider: profile.provider,
    model: profile.model,
    ratio: '720:1280',
    hasAudio: false,
    currency: 'USD',
    clips,
    maxCostCents: clips.reduce((sum, clip) => sum + clip.costCents, 0),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    approvedApprovalId: null,
    consumedByJobId: null,
  });
}
