import {
  creatorImageQuoteSchema,
  creatorImageSettingsSchema,
  creatorImageStartSchema,
  type CreatorImageJob,
  type CreatorImageLibrary,
  type CreatorImageQuote,
  type CreatorImageSettings,
} from '@yap/contracts/creator-images';
import type { CreatorSession } from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';

export type ImageRequestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface SavedImageRequest {
  quote: CreatorImageQuote;
  requestId: string;
}
export const activeImageJob = (job: CreatorImageJob) => ['queued', 'running'].includes(job.status);
export const imageSettingsKey = (settings: CreatorImageSettings) =>
  JSON.stringify(creatorImageSettingsSchema.parse(settings));

export function imageSourceHash(
  settings: CreatorImageSettings,
  workflow: Pick<Workflow, 'assets'>,
  library: CreatorImageLibrary,
): string | null | undefined {
  if (settings.parentVariantId)
    return library.variants.find((item) => item.id === settings.parentVariantId)?.media.sha256;
  if (settings.sourceAssetId)
    return workflow.assets.find((item) => item.id === settings.sourceAssetId)?.sha256;
  return null;
}

export function imageQuoteCurrent(
  quote: CreatorImageQuote | null,
  session: Pick<CreatorSession, 'id' | 'version' | 'plan'>,
  workflow: Pick<Workflow, 'version' | 'assets'>,
  settings: CreatorImageSettings,
  library: CreatorImageLibrary,
  now = Date.now(),
): boolean {
  return Boolean(
    quote &&
    quote.sessionId === session.id &&
    quote.sessionVersion === session.version &&
    quote.workflowVersion === workflow.version &&
    !quote.consumedByJobId &&
    Date.parse(quote.expiresAt) > now &&
    imageSettingsKey(quote.settings) === imageSettingsKey(settings) &&
    quote.sourceSha256 === imageSourceHash(settings, workflow, library) &&
    (!settings.clipId || session.plan?.clips.some((clip) => clip.id === settings.clipId)),
  );
}

const requestKey = (sessionId: string) => `yap.creator.image-request:${sessionId}`;
export function readImageRequest(
  storage: ImageRequestStorage,
  sessionId: string,
): SavedImageRequest | null {
  try {
    const raw = storage.getItem(requestKey(sessionId));
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (
      !record ||
      typeof record !== 'object' ||
      !('version' in record) ||
      record.version !== 1 ||
      !('quote' in record) ||
      !('requestId' in record)
    )
      throw new Error();
    const quote = creatorImageQuoteSchema.parse(record.quote);
    if (quote.sessionId !== sessionId) throw new Error();
    const start = creatorImageStartSchema.parse({
      expectedVersion: quote.sessionVersion,
      expectedWorkflowVersion: quote.workflowVersion,
      quoteId: quote.id,
      requestId: record.requestId,
      costReviewed: true,
    });
    return { quote, requestId: start.requestId };
  } catch {
    throw new Error(
      'The saved image request could not be read. Check saved image activity before starting another paid request.',
    );
  }
}

export function saveImageRequest(storage: ImageRequestStorage, record: SavedImageRequest): void {
  try {
    const existing = readImageRequest(storage, record.quote.sessionId);
    if (
      existing &&
      (existing.quote.id !== record.quote.id || existing.requestId !== record.requestId)
    )
      throw new Error();
    storage.setItem(requestKey(record.quote.sessionId), JSON.stringify({ version: 1, ...record }));
    if (readImageRequest(storage, record.quote.sessionId)?.requestId !== record.requestId)
      throw new Error();
  } catch {
    throw new Error(
      'The image request could not be saved safely. Enable browser storage before starting paid generation; no new request was submitted.',
    );
  }
}

export function clearKnownImageRequest(
  storage: ImageRequestStorage,
  record: SavedImageRequest,
  jobs: CreatorImageJob[],
): boolean {
  if (
    !jobs.some(
      (job) =>
        job.sessionId === record.quote.sessionId &&
        job.quoteId === record.quote.id &&
        job.requestId === record.requestId,
    )
  )
    return false;
  const current = readImageRequest(storage, record.quote.sessionId);
  if (!current || current.quote.id !== record.quote.id || current.requestId !== record.requestId)
    return false;
  storage.removeItem(requestKey(record.quote.sessionId));
  return true;
}

/** Only an explicit pre-submission rejection plus a fresh successful history read resolves uncertainty. */
export function clearRejectedImageRequest(
  storage: ImageRequestStorage,
  record: SavedImageRequest,
  jobs: CreatorImageJob[],
  rejection: { status: number; code: string },
): boolean {
  const definitive = [
    'CREATOR_IMAGE_QUOTE_EXPIRED',
    'CREATOR_IMAGE_QUOTE_STALE',
    'CREATOR_IMAGE_QUOTE_NOT_FOUND',
    'CREATOR_IMAGE_CLIP_STALE',
    'CREATOR_IMAGE_SOURCE_CHANGED',
    'CREATOR_IMAGE_SOURCE_MISSING',
    'CREATOR_VERSION_CONFLICT',
    'INVALID_CREATOR_IMAGE_INPUT',
    'INVALID_CREATOR_INPUT',
  ];
  if (
    rejection.status < 400 ||
    rejection.status >= 500 ||
    !definitive.includes(rejection.code) ||
    jobs.some(
      (job) =>
        job.sessionId === record.quote.sessionId &&
        (job.requestId === record.requestId || job.quoteId === record.quote.id),
    )
  )
    return false;
  const current = readImageRequest(storage, record.quote.sessionId);
  if (!current || current.quote.id !== record.quote.id || current.requestId !== record.requestId)
    return false;
  storage.removeItem(requestKey(record.quote.sessionId));
  return readImageRequest(storage, record.quote.sessionId) === null;
}

export function imageSubmissionDecision(
  jobs: CreatorImageJob[],
  quote: CreatorImageQuote,
  remembered: SavedImageRequest | null,
): { kind: 'existing'; job: CreatorImageJob } | { kind: 'submit'; requestId: string | null } {
  const active = jobs.find(activeImageJob);
  if (active) return { kind: 'existing', job: active };
  const existing = jobs.find(
    (job) => job.sessionId === quote.sessionId && job.quoteId === quote.id,
  );
  if (existing) return { kind: 'existing', job: existing };
  if (quote.consumedByJobId)
    throw new Error(
      'This image quote was already used. Refresh saved activity to recover its job before requesting another image.',
    );
  if (remembered && remembered.quote.id !== quote.id)
    throw new Error(
      'Resolve the earlier image request in saved activity before reviewing another paid image.',
    );
  return { kind: 'submit', requestId: remembered?.requestId ?? null };
}
