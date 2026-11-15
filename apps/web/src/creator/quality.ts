import type {
  CreatorJob,
  CreatorPlan,
  CreatorPromptReview,
  CreatorSession,
} from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import { isActiveJob, planCurrent, planDraft } from './model';

export interface SavedPromptContext {
  sessionId: string;
  planId: string;
  workflowVersion: number;
}

export function savedPromptContext(
  session: CreatorSession | undefined,
  workflow: Workflow | undefined,
  blocked = false,
): SavedPromptContext | null {
  if (!session || !workflow || blocked || !planCurrent(session, workflow) || !session.plan)
    return null;
  return {
    sessionId: session.id,
    planId: session.plan.id,
    workflowVersion: workflow.version,
  };
}

/** A late response must match both the request's session and the still-current saved material. */
export function promptReviewMatches(
  review: CreatorPromptReview,
  requested: SavedPromptContext,
  current: SavedPromptContext | null,
): boolean {
  return Boolean(
    current &&
    requested.sessionId === current.sessionId &&
    requested.planId === current.planId &&
    requested.workflowVersion === current.workflowVersion &&
    review.planId === current.planId &&
    review.workflowVersion === current.workflowVersion,
  );
}

type PlanDraft = Pick<CreatorPlan, 'clips' | 'caption'>;

/** Stage only wording from a receipt belonging to this exact, otherwise untouched plan. */
export function stageClipRevision(
  draft: PlanDraft | null,
  session: CreatorSession | undefined,
  workflow: Workflow | undefined,
  job: CreatorJob,
  clipId: string,
  attempt: number,
  blocked = false,
): PlanDraft | null {
  const context = savedPromptContext(session, workflow, blocked);
  if (
    !context ||
    !draft ||
    job.kind !== 'production' ||
    isActiveJob(job) ||
    job.sessionId !== context.sessionId ||
    job.planId !== context.planId ||
    job.workflowVersion !== context.workflowVersion ||
    JSON.stringify(draft) !== JSON.stringify(planDraft(session?.plan ?? null))
  )
    return null;
  const receipt = job.clips
    .filter((item) => item.clipId === clipId)
    .reduce<CreatorJob['clips'][number] | undefined>(
      (latest, item) => (!latest || item.attempt >= latest.attempt ? item : latest),
      undefined,
    );
  if (!receipt || receipt.attempt !== attempt) return null;
  const revision = receipt.audit?.suggestedRevision;
  if (!revision || !draft.clips.some((clip) => clip.id === clipId)) return null;
  return {
    ...draft,
    clips: draft.clips.map((clip) =>
      clip.id === clipId
        ? { ...clip, prompt: revision.prompt, camera: revision.camera, lighting: revision.lighting }
        : clip,
    ),
  };
}
