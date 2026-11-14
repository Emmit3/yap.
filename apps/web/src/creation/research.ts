import type { SocialHandoff } from '@yap/contracts/social';
import { creatorApi } from '../creator/api';
import { promoApi } from '../promo/api';
import { validateResearchContext } from '../research-context';

export type CreationKind = 'video' | 'photo';
export type CreationContext = {
  topic: string;
  audience?: string;
  research?: SocialHandoff;
  resourceId?: string;
  isBusy?: boolean;
};
export type CreationResearchClients = {
  creator: Pick<typeof creatorApi, 'get' | 'jobs'>;
  promo: Pick<typeof promoApi, 'get' | 'getRenders' | 'refine'>;
};
const defaultClients: CreationResearchClients = { creator: creatorApi, promo: promoApi };

export async function creationContext(
  kind: CreationKind,
  id: string,
  signal: AbortSignal,
  clients = defaultClients,
) {
  const { workflow } =
    kind === 'video' ? await clients.creator.get(id, signal) : await clients.promo.get(id, signal);
  return {
    topic: workflow.brief.productName || workflow.title,
    audience: workflow.brief.audience,
    research: workflow.research,
  } satisfies CreationContext;
}

/** Attach context only. Version checks invalidate stale proposals; this never approves or renders. */
export async function applyCreationResearch(
  kind: CreationKind,
  id: string,
  handoff: SocialHandoff,
  signal: AbortSignal,
  isDirty: () => boolean,
  clients = defaultClients,
) {
  const research = validateResearchContext(handoff);
  if (isDirty())
    throw new Error('Save your creation edits before applying research. Your research stays here.');
  const [saved, jobs] = await Promise.all([
    kind === 'video' ? clients.creator.get(id, signal) : clients.promo.get(id, signal),
    kind === 'video'
      ? clients.creator.jobs(id, signal).then((result) => result.jobs)
      : clients.promo.getRenders(id, signal),
  ]);
  signal.throwIfAborted();
  if (isDirty())
    throw new Error('Save your creation edits before applying research. Your research stays here.');
  if (jobs.some((job) => job.status === 'queued' || job.status === 'running'))
    throw new Error(
      'Wait for the active research or video job to finish before changing its research context.',
    );
  return clients.promo.refine(
    saved.workflow.id,
    { expectedVersion: saved.workflow.version, research },
    signal,
  );
}
