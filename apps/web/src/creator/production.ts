import { creatorProduceSchema, type CreatorJob } from '@yap/contracts/creator';
import { isActiveJob } from './model';

type RequestStorage = Pick<Storage, 'getItem' | 'setItem'>;
const keyFor = (sessionId: string, approvalId: string, quoteId: string) =>
  `yap.creator.production:${sessionId}:${approvalId}:${quoteId}`;

export function browserRequestStorage(): RequestStorage {
  try {
    return localStorage;
  } catch {
    throw new Error(
      'Browser storage is unavailable. Enable site storage before starting paid clips. No generation was submitted.',
    );
  }
}

export function readProductionRequest(
  storage: RequestStorage,
  sessionId: string,
  approvalId: string,
  quoteId: string,
): string | null {
  try {
    const value = storage.getItem(keyFor(sessionId, approvalId, quoteId));
    if (value === null) return null;
    const record: unknown = JSON.parse(value);
    if (
      typeof record !== 'object' ||
      record === null ||
      Array.isArray(record) ||
      !('version' in record) ||
      record.version !== 2 ||
      !('sessionId' in record) ||
      record.sessionId !== sessionId ||
      !('approvalId' in record) ||
      record.approvalId !== approvalId ||
      !('quoteId' in record) ||
      record.quoteId !== quoteId ||
      !('requestId' in record)
    )
      throw new Error('Invalid request receipt.');
    return creatorProduceSchema.parse({
      expectedVersion: 1,
      approvalId,
      quoteId,
      requestId: record.requestId,
    }).requestId;
  } catch {
    throw new Error(
      'The saved generation request could not be read. Review saved job activity before retrying; no new paid request was submitted.',
    );
  }
}

export function saveProductionRequest(
  storage: RequestStorage,
  sessionId: string,
  approvalId: string,
  quoteId: string,
  requestId: string,
): void {
  try {
    creatorProduceSchema.parse({ expectedVersion: 1, approvalId, quoteId, requestId });
    storage.setItem(
      keyFor(sessionId, approvalId, quoteId),
      JSON.stringify({ version: 2, sessionId, approvalId, quoteId, requestId }),
    );
    if (readProductionRequest(storage, sessionId, approvalId, quoteId) !== requestId)
      throw new Error('Request was not retained.');
  } catch {
    throw new Error(
      'The generation request could not be saved safely in this browser. No paid request was submitted.',
    );
  }
}

export type ProductionDecision =
  { kind: 'reconnect'; job: CreatorJob } | { kind: 'submit'; requestId: string | null };

/** Reconcile durable server history before deciding whether any paid submission is needed. */
export function productionDecision(
  jobs: CreatorJob[],
  approvalId: string,
  quoteId: string,
  rememberedRequestId: string | null,
): ProductionDecision {
  const production = jobs
    .filter((job) => job.kind === 'production')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = production.find(isActiveJob);
  if (active) return { kind: 'reconnect', job: active };
  const approved = production.filter(
    (job) => job.approvalId === approvalId && job.quoteId === quoteId,
  );
  const complete = approved.find((job) => job.status === 'succeeded');
  if (complete) return { kind: 'reconnect', job: complete };
  const latest = approved[0];
  // A failed or canceled quote is consumed too. A deliberate retry needs a new quote and review.
  if (latest) return { kind: 'reconnect', job: latest };
  return { kind: 'submit', requestId: rememberedRequestId };
}
