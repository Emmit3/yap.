import {
  creatorInputSchema,
  type CreatorAnswer,
  type CreatorClip,
  type CreatorInput,
  type CreatorJob,
  type CreatorPlan,
  type CreatorQuestion,
  type CreatorSession,
} from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';

export const isActiveJob = (job: CreatorJob | null | undefined) =>
  job?.status === 'queued' || job?.status === 'running';

export const mediaStarterPrompt =
  'Create a short film from my supplied photos. Ask me what they show and what I want to communicate.';

export function startingPrompt(prompt: string, photoCount: number) {
  if (prompt.trim()) return prompt.trim();
  if (photoCount > 0) return mediaStarterPrompt;
  throw new Error('Add a photo or a little text to start your film.');
}

export function sourceInput(
  mode: 'media' | 'text',
  prompt: string,
  location: string,
  urls: string,
  preferences: Pick<CreatorInput, 'platform' | 'duration' | 'tone'> = {},
): CreatorInput {
  const parsed = creatorInputSchema.safeParse({
    mode,
    prompt: prompt.trim(),
    ...(location.trim() ? { location: location.trim() } : {}),
    urls: [
      ...new Set(
        urls
          .split(/\s+/)
          .map((url) => url.trim())
          .filter(Boolean),
      ),
    ],
    ...preferences,
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'Idea'}: ${issue.message}`)
        .join(' '),
    );
  }
  return parsed.data;
}

export function nextQuestion(session: CreatorSession, workflow: Workflow): CreatorQuestion | null {
  const needsMediaDescription =
    session.input.prompt === mediaStarterPrompt &&
    !session.answers.some(
      (answer) => answer.questionId === 'productDescription' && answer.answer.trim(),
    );
  const answered = new Set(
    session.answers.filter((answer) => answer.answer.trim()).map((answer) => answer.questionId),
  );
  workflow.questions
    .filter(
      (question) =>
        question.status === 'answered' &&
        !(question.id === 'productDescription' && needsMediaDescription),
    )
    .forEach((question) => answered.add(question.id));
  const questions =
    session.research?.questions ??
    workflow.questions
      .filter(
        (question) =>
          question.status === 'open' ||
          (question.id === 'productDescription' && needsMediaDescription),
      )
      .map((question) => ({
        id: question.id,
        question: question.question,
        why: 'A clear detail helps shape the proposal.',
      }));
  return questions.find((question) => !answered.has(question.id)) ?? null;
}

export function withAnswer(
  answers: CreatorAnswer[],
  questionId: string,
  answer: string,
): CreatorAnswer[] {
  return [
    ...answers.filter((item) => item.questionId !== questionId),
    { questionId, answer: answer.trim() },
  ];
}

export function planCurrent(session: CreatorSession, workflow: Workflow): boolean {
  const plan = session.plan;
  return Boolean(
    plan &&
    plan.workflowVersion === workflow.version &&
    plan.scriptId === workflow.script?.id &&
    plan.sourceScenesId === workflow.scenes?.id,
  );
}

export function approvalCurrent(session: CreatorSession, workflow: Workflow): boolean {
  return Boolean(
    planCurrent(session, workflow) &&
    session.approval &&
    session.approval.planId === session.plan?.id &&
    session.approval.workflowVersion === workflow.version,
  );
}

export function generatedSeconds(clips: CreatorClip[], attempts = 2) {
  return clips.reduce((total, clip) => total + clip.seconds, 0) * attempts;
}

export function planDraft(plan: CreatorPlan | null) {
  return plan ? { clips: plan.clips.map((clip) => ({ ...clip })), caption: plan.caption } : null;
}

export function combineScriptMoments(
  segments: NonNullable<Workflow['script']>['segments'],
  index: number,
): { segments: NonNullable<Workflow['script']>['segments'] | null; reason: string } {
  const first = segments[index];
  const second = segments[index + 1];
  if (!Number.isInteger(index) || index < 0 || !first || !second)
    return { segments: null, reason: 'Choose a moment with another moment after it.' };
  const text = `${first.text}\n${second.text}`;
  const seconds = first.seconds + second.seconds;
  if (text.length > 2000)
    return {
      segments: null,
      reason: 'Shorten these two texts to 2,000 characters before combining.',
    };
  if (seconds > 60)
    return {
      segments: null,
      reason: 'Reduce their combined duration to 60 seconds or less first.',
    };
  return {
    segments: [
      ...segments.slice(0, index),
      { ...first, text, seconds },
      ...segments.slice(index + 2),
    ],
    reason: '',
  };
}

export function checkedPhotos(files: File[], savedCount: number, queuedCount: number) {
  if (savedCount + queuedCount + files.length > 20)
    throw new Error(
      'A studio can hold up to 20 product photos. Remove a photo before adding more.',
    );
  const invalid = files.find(
    (file) =>
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size === 0 ||
      file.size > 10 * 1024 * 1024,
  );
  if (invalid) throw new Error(`${invalid.name}: choose a JPEG, PNG or WebP photo under 10 MiB.`);
  return files;
}

export function outputIsCurrent(
  job: CreatorJob | null,
  session: CreatorSession,
  workflow: Workflow,
) {
  return Boolean(
    job?.kind === 'production' &&
    job.status === 'succeeded' &&
    job.output &&
    approvalCurrent(session, workflow) &&
    job.approvalId === session.approval?.id,
  );
}

export function clipPreviewIsCurrent(
  job: CreatorJob | null,
  session: CreatorSession,
  workflow: Workflow,
) {
  return Boolean(
    job?.kind === 'production' &&
    approvalCurrent(session, workflow) &&
    job.approvalId === session.approval?.id &&
    job.workflowVersion === workflow.version,
  );
}
