import {
  creatorQuoteSchema,
  type CreatorBudgetSnapshot,
  type CreatorQuote,
  type CreatorSession,
} from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import { approvalCurrent, planCurrent } from './model';

type QuoteStorage = Pick<Storage, 'getItem' | 'setItem'>;
const storageKey = (sessionId: string) => `yap.creator.quote:${sessionId}`;
function profileIdentity(id: string) {
  const landscape = id.endsWith('landscape');
  return {
    provider: id.startsWith('fal-') ? 'fal' : 'runway',
    model: id.startsWith('fal-')
      ? 'seedance-v1.5-pro'
      : id.startsWith('runway-gen4turbo-')
        ? 'gen4_turbo'
        : 'gen4.5',
    ratio: landscape ? '1280:720' : '720:1280',
    nativeWidth: landscape ? 1280 : 720,
    nativeHeight: landscape ? 720 : 1280,
  };
}

export function formatUsd(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error('The server cost could not be read.');
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function costsConsistent(quote: CreatorQuote): boolean {
  return (
    quote.maxCostCents ===
      quote.clips.reduce((sum, clip) => sum + clip.costCents, 0) + quote.audioCents &&
    quote.clips.every(
      (clip) =>
        clip.costCents === clip.videoCents + clip.visionCents &&
        (!clip.reuse || clip.costCents === 0),
    )
  );
}

/** Display guards mirror versions and identities; the server remains the cost/approval authority. */
export function quoteIsCurrent(
  quote: CreatorQuote | null,
  session: CreatorSession,
  workflow: Workflow,
  nowMs = Date.now(),
): boolean {
  const plan = session.plan;
  const firstProfile = plan?.clips[0]?.videoProfileId
    ? profileIdentity(plan.clips[0].videoProfileId)
    : undefined;
  if (
    !quote ||
    !plan ||
    !planCurrent(session, workflow) ||
    !costsConsistent(quote) ||
    quote.sessionId !== session.id ||
    quote.planId !== plan.id ||
    quote.model !== (firstProfile?.model ?? plan.model) ||
    quote.provider !== (firstProfile?.provider ?? plan.provider ?? 'runway') ||
    quote.ratio !== (plan.outputProfileId === 'landscape-720' ? '1280:720' : plan.ratio) ||
    quote.outputProfileId !== plan.outputProfileId ||
    quote.brandSnapshot?.sha256 !== plan.brandSnapshot?.sha256 ||
    quote.hasAudio !== plan.hasAudio ||
    quote.subtitlesEnabled !== plan.subtitlesEnabled ||
    quote.consumedByJobId ||
    !Number.isFinite(nowMs) ||
    Date.parse(quote.expiresAt) <= nowMs ||
    quote.clips.length !== plan.clips.length ||
    new Set(quote.clips.map((clip) => clip.clipId)).size !== quote.clips.length ||
    quote.clips.some(
      (clip) =>
        !plan.clips.some((source) => {
          if (
            source.id !== clip.clipId ||
            source.seconds !== clip.seconds ||
            source.videoProfileId !== clip.videoProfileId
          )
            return false;
          if (!source.videoProfileId) return true;
          const profile = profileIdentity(source.videoProfileId);
          return (
            clip.provider === profile.provider &&
            clip.model === profile.model &&
            clip.ratio === profile.ratio &&
            clip.nativeWidth === profile.nativeWidth &&
            clip.nativeHeight === profile.nativeHeight
          );
        }),
    )
  )
    return false;

  const approved = session.approval?.quoteId === quote.id && approvalCurrent(session, workflow);
  if (quote.approvedApprovalId && quote.approvedApprovalId !== session.approval?.id) return false;
  if (approved)
    return (
      quote.sessionVersion + 1 === session.version &&
      (quote.workflowVersion === workflow.version || quote.workflowVersion + 1 === workflow.version)
    );
  return (
    !quote.approvedApprovalId &&
    quote.sessionVersion === session.version &&
    quote.workflowVersion === workflow.version
  );
}

export function quoteIsAffordable(
  quote: CreatorQuote | null,
  budget: CreatorBudgetSnapshot | null,
): boolean {
  return Boolean(
    quote &&
    budget &&
    costsConsistent(quote) &&
    quote.currency === budget.currency &&
    quote.maxCostCents <= budget.availableCents,
  );
}

export function readSavedQuote(storage: QuoteStorage, sessionId: string): CreatorQuote | null {
  try {
    const raw = storage.getItem(storageKey(sessionId));
    if (raw === null) return null;
    const record: unknown = JSON.parse(raw);
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      !('version' in record) ||
      record.version !== 1 ||
      !('sessionId' in record) ||
      record.sessionId !== sessionId ||
      !('quote' in record)
    )
      throw new Error('Invalid quote record.');
    const quote = creatorQuoteSchema.parse(record.quote);
    if (quote.sessionId !== sessionId || !costsConsistent(quote))
      throw new Error('Mismatched quote.');
    return quote;
  } catch {
    throw new Error(
      'The saved quote could not be read. Existing jobs can still be reconnected; request a fresh quote before any new paid work.',
    );
  }
}

export function saveQuote(storage: QuoteStorage, quote: CreatorQuote): void {
  try {
    creatorQuoteSchema.parse(quote);
    if (!costsConsistent(quote)) throw new Error('Inconsistent quote costs.');
    storage.setItem(
      storageKey(quote.sessionId),
      JSON.stringify({ version: 1, sessionId: quote.sessionId, quote }),
    );
    const saved = readSavedQuote(storage, quote.sessionId);
    if (JSON.stringify(saved) !== JSON.stringify(quote)) throw new Error('Quote was not retained.');
  } catch {
    throw new Error(
      'This browser could not retain the exact quote. No paid work was submitted. Enable site storage and request a fresh quote.',
    );
  }
}
