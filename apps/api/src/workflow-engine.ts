import { randomUUID } from 'node:crypto';
import {
  workflowBriefSchema,
  workflowQueryResponseSchema,
  workflowSchema,
  workflowScenesSchema,
  workflowScriptSchema,
  type CreateWorkflowInput,
  type RefineWorkflowInput,
  type RefinementQuestion,
  type UpdateWorkflowScenesInput,
  type UpdateWorkflowScriptInput,
  type Workflow,
  type WorkflowBrief,
  type WorkflowCheck,
  type WorkflowQueryEvidence,
  type WorkflowQueryResponse,
  type WorkflowScenes,
  type WorkflowScript,
  type WorkflowStage,
  type WorkflowStageVerification,
  type WorkflowVerification,
} from '@yap/contracts/workflow';
import { ApiError } from './errors.js';

const questionDefinitions = [
  ['productName', 'What is the product or idea called?'],
  ['productDescription', 'What is it, and what should someone understand about it?'],
  ['audience', 'Who is this video for?'],
  [
    'keyBenefits',
    'What do you want people to like about it? List the benefits or details to feature.',
  ],
  ['callToAction', 'What should someone do after watching?'],
  [
    'imageDirection',
    'How should the supplied images appear in the video, and what should they highlight?',
  ],
] as const;

function message(text: string, role: 'user' | 'assistant', kind: 'input' | 'refinement') {
  return { id: randomUUID(), role, kind, text, createdAt: new Date().toISOString() };
}

export function buildQuestions(
  workflow: Pick<Workflow, 'brief' | 'assets'> & Partial<Pick<Workflow, 'questions'>>,
): RefinementQuestion[] {
  return questionDefinitions
    .filter(([field]) => field !== 'imageDirection' || workflow.assets.length > 0)
    .map(([field, question]) => {
      const value = workflow.brief[field];
      const previous = workflow.questions?.find((item) => item.field === field);
      const isDefault =
        (field === 'productName' && value === 'Your business') ||
        (field === 'audience' && value === 'Local customers') ||
        (field === 'callToAction' && value === 'Visit us');
      const answer =
        isDefault && !(previous?.status === 'answered' && previous.answer === value)
          ? undefined
          : Array.isArray(value)
            ? value.join('; ')
            : value;
      return {
        id: field,
        field,
        question,
        status: answer ? 'answered' : 'open',
        ...(answer ? { answer: answer.length > 4000 ? `${answer.slice(0, 3999)}…` : answer } : {}),
      };
    });
}

function markExplicitAnswers(workflow: Workflow, fields: string[]): void {
  const explicit = new Set(fields);
  workflow.questions = workflow.questions.map((question) => {
    if (!explicit.has(question.field)) return question;
    const value = workflow.brief[question.field];
    const answer = Array.isArray(value) ? value.join('; ') : value;
    return answer
      ? {
          ...question,
          status: 'answered',
          answer: answer.length > 4000 ? `${answer.slice(0, 3999)}…` : answer,
        }
      : question;
  });
}

function refinementReply(workflow: Pick<Workflow, 'brief' | 'assets'>): string {
  const open = buildQuestions(workflow).filter((question) => question.status === 'open');
  if (open.length) {
    return `Your input is saved. Help shape the video by answering these questions:\n\n${open.map((question) => question.question).join('\n\n')}\n\nYou can also change the platform, duration, and tone in the brief. Guided refinement saves your instructions; it does not infer facts from images or arbitrary text.`;
  }
  return 'The brief has the details needed for review. Check the product claims and image direction, then approve this brief to create a script. Your approval applies only to this content revision.';
}

export function createWorkflow(input: CreateWorkflowInput): Workflow {
  const now = new Date().toISOString();
  const initial: Workflow = {
    id: randomUUID(),
    version: 1,
    contentRevision: 1,
    title: input.title ?? input.brief?.productName ?? input.input.slice(0, 120),
    input: input.input,
    brief: {
      productName: input.title ?? 'Your business',
      productDescription: input.input.slice(0, 4000),
      audience: 'Local customers',
      callToAction: 'Visit us',
      tone: 'conversational',
      platform: 'instagram',
      duration: 30,
      ...input.brief,
    },
    assets: [],
    messages: [],
    questions: [],
    script: null,
    scenes: null,
    approvals: { brief: null, script: null, scenes: null },
    createdAt: now,
    updatedAt: now,
  };
  initial.questions = buildQuestions(initial);
  markExplicitAnswers(initial, Object.keys(input.brief ?? {}));
  initial.messages = [
    message(input.input, 'user', 'input'),
    message(refinementReply(initial), 'assistant', 'refinement'),
  ];
  return workflowSchema.parse(initial);
}

/** Root orchestration increments version/updatedAt once after the mutation is committed. */
export function invalidateWorkflowContent(workflow: Workflow): Workflow {
  const next = structuredClone(workflow);
  next.contentRevision += 1;
  next.script = null;
  next.scenes = null;
  next.approvals = { brief: null, script: null, scenes: null };
  next.questions = buildQuestions(next);
  return next;
}

function benefitAnswers(answer: string): string[] {
  return answer
    .split(/[\n;]+/)
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

export function refineWorkflow(workflow: Workflow, input: RefineWorkflowInput): Workflow {
  if (workflow.messages.length > 198) {
    throw new ApiError(
      409,
      'WORKFLOW_HISTORY_LIMIT',
      'This workflow has reached its conversation limit. Start a new workflow to continue refining.',
    );
  }
  const answers = input.answers;
  const brief: WorkflowBrief = { ...workflow.brief };
  if (answers) {
    const { keyBenefits, ...textAnswers } = answers;
    Object.assign(brief, textAnswers);
    if (keyBenefits !== undefined) brief.keyBenefits = benefitAnswers(keyBenefits);
  }
  Object.assign(brief, input.brief);
  const parsed = workflowBriefSchema.safeParse(brief);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'INVALID_REFINEMENT_ANSWER',
      'Check the refinement answers. List up to ten benefits separated by new lines or semicolons, with at most 500 characters per benefit.',
      parsed.error.issues.map((issue) => ({
        path: `brief.${issue.path.join('.')}`,
        message: issue.message,
      })),
    );
  }
  const next = invalidateWorkflowContent({ ...workflow, brief: parsed.data });
  const fields = [
    ...new Set([...Object.keys(input.answers ?? {}), ...Object.keys(input.brief ?? {})]),
  ];
  markExplicitAnswers(next, fields);
  const text = input.message ?? `Updated the following brief fields: ${fields.join(', ')}.`;
  next.messages.push(
    message(text, 'user', 'refinement'),
    message(refinementReply(next), 'assistant', 'refinement'),
  );
  return workflowSchema.parse(next);
}

function check(
  code: string,
  passed: boolean,
  messageText: string,
  path?: string,
  severity: 'error' | 'warning' = 'error',
): WorkflowCheck {
  return { code, passed, severity, message: messageText, ...(path ? { path } : {}) };
}

function report(
  stage: WorkflowStage,
  checks: WorkflowCheck[],
  approved: boolean,
  upstreamApproved = true,
): WorkflowStageVerification {
  const structurallyValid = !checks.some((item) => item.severity === 'error' && !item.passed);
  const canApprove = structurallyValid && upstreamApproved;
  return {
    stage,
    state: !structurallyValid
      ? 'blocked'
      : approved && upstreamApproved
        ? 'approved'
        : 'needs_review',
    checks,
    canApprove,
  };
}

function totalSeconds(items: Array<{ seconds: number }>): number {
  return items.reduce((sum, item) => sum + item.seconds, 0);
}

function uniqueIds(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

export function verifyWorkflow(workflow: Workflow): WorkflowVerification {
  const briefFields = [
    'productName',
    'productDescription',
    'audience',
    'callToAction',
    'tone',
    'platform',
    'duration',
  ] as const;
  const briefChecks = briefFields.map((field) =>
    check(
      `BRIEF_${field.toUpperCase()}`,
      Boolean(workflow.brief[field]),
      `Provide ${field.replace(/([A-Z])/g, ' $1').toLowerCase()} before approving the brief.`,
      `brief.${field}`,
    ),
  );
  briefChecks.push(
    check(
      'BRIEF_SCHEMA',
      workflowBriefSchema.safeParse(workflow.brief).success,
      'The brief fields must satisfy the shared content limits.',
      'brief',
    ),
  );
  briefChecks.push(
    check(
      'DEFAULTS_REVIEW_REQUIRED',
      false,
      'Review the proposed business name, audience, call to action, platform, duration, and tone. Defaults are editable starting points, not confirmed product facts.',
      'brief',
      'warning',
    ),
  );
  briefChecks.push(
    check(
      'KEY_BENEFITS_PROVIDED',
      Boolean(workflow.brief.keyBenefits?.length),
      'Add the benefits or details you want people to like. Without them, the proposal uses only your initial description.',
      'brief.keyBenefits',
      'warning',
    ),
  );
  if (workflow.assets.length)
    briefChecks.push(
      check(
        'IMAGE_DIRECTION_REVIEW',
        Boolean(workflow.brief.imageDirection),
        'Describe which image details to highlight, or review the proposed placements before final approval.',
        'brief.imageDirection',
        'warning',
      ),
    );
  briefChecks.push(
    check(
      'CREATOR_FACT_REVIEW',
      false,
      'Product claims and image relevance require your review. Structural checks do not establish factual accuracy.',
      'brief',
      'warning',
    ),
  );
  const brief = report('brief', briefChecks, workflow.approvals.brief === workflow.contentRevision);

  const scriptChecks = [
    check(
      'BRIEF_APPROVED',
      brief.state === 'approved',
      'Approve the current brief before approving an individual script stage.',
      'approvals.brief',
      'warning',
    ),
    check(
      'SCRIPT_EXISTS',
      workflow.script !== null,
      'Create a script from the approved brief.',
      'script',
    ),
  ];
  const script = workflow.script;
  if (script) {
    scriptChecks.push(
      check(
        'SCRIPT_SCHEMA',
        workflowScriptSchema.safeParse(script).success,
        'Script content must satisfy the shared content limits.',
        'script',
      ),
      check(
        'SCRIPT_SOURCE_CURRENT',
        script.sourceRevision === workflow.contentRevision,
        'The script must use the current content revision.',
        'script.sourceRevision',
      ),
      check(
        'SCRIPT_SEGMENT_IDS',
        uniqueIds(script.segments),
        'Each script segment must have a unique ID.',
        'script.segments',
      ),
      check(
        'SCRIPT_DURATION',
        totalSeconds(script.segments) === workflow.brief.duration,
        `Script segments must add up to ${workflow.brief.duration ?? 'the target'} seconds.`,
        'script.segments',
      ),
      check(
        'SCRIPT_READING_PACE',
        script.segments.every(
          (segment) => segment.text.split(/\s+/).filter(Boolean).length <= segment.seconds * 3,
        ),
        'Read the script aloud. A segment exceeds approximately three words per second.',
        'script.segments',
        'warning',
      ),
      check(
        'SCRIPT_FACT_REVIEW',
        false,
        'Review the spoken claims, tone, and call to action before approving this script.',
        'script',
        'warning',
      ),
    );
  }
  const scriptReport = report(
    'script',
    scriptChecks,
    Boolean(script && workflow.approvals.script === script.id),
    brief.state === 'approved',
  );

  const scenesChecks = [
    check(
      'SCRIPT_APPROVED',
      scriptReport.state === 'approved',
      'Approve the current script before approving an individual scene stage.',
      'approvals.script',
      'warning',
    ),
    check(
      'SCENES_EXIST',
      workflow.scenes !== null,
      'Create scenes from the approved script.',
      'scenes',
    ),
  ];
  const scenes = workflow.scenes;
  if (scenes) {
    const segmentMap = new Map(script?.segments.map((segment) => [segment.id, segment]) ?? []);
    const linkedSegments = scenes.scenes.map((scene) => scene.scriptSegmentId);
    const assetIds = new Set(workflow.assets.map((asset) => asset.id));
    scenesChecks.push(
      check(
        'SCENES_SCHEMA',
        workflowScenesSchema.safeParse(scenes).success,
        'Scene content must satisfy the shared content limits.',
        'scenes',
      ),
      check(
        'SCENES_SOURCE_CURRENT',
        Boolean(script && scenes.sourceScriptId === script.id),
        'Scenes must reference the current script.',
        'scenes.sourceScriptId',
      ),
      check(
        'SCENE_IDS',
        uniqueIds(scenes.scenes),
        'Each scene must have a unique ID.',
        'scenes.scenes',
      ),
      check(
        'SCENE_SEGMENT_COVERAGE',
        linkedSegments.length === segmentMap.size &&
          new Set(linkedSegments).size === linkedSegments.length &&
          linkedSegments.every((id) => segmentMap.has(id)),
        'Each script segment must be covered by exactly one scene.',
        'scenes.scenes',
      ),
      check(
        'SCENE_SEGMENT_TIMING',
        scenes.scenes.every(
          (scene) => scene.seconds === segmentMap.get(scene.scriptSegmentId)?.seconds,
        ),
        'Each scene duration must match its script segment.',
        'scenes.scenes',
      ),
      check(
        'SCENES_DURATION',
        totalSeconds(scenes.scenes) === workflow.brief.duration,
        `Scenes must add up to ${workflow.brief.duration ?? 'the target'} seconds.`,
        'scenes.scenes',
      ),
      check(
        'SCENE_ASSET_REFERENCES',
        scenes.scenes.every(
          (scene) =>
            new Set(scene.assetIds).size === scene.assetIds.length &&
            scene.assetIds.every((id) => assetIds.has(id)),
        ),
        'Scenes may only reference unique image IDs attached to this workflow.',
        'scenes.scenes',
      ),
      check(
        'SCENE_VISUAL_REVIEW',
        false,
        'Review scene directions and image placement. A scene plan is not rendered footage or proof of what an image depicts.',
        'scenes',
        'warning',
      ),
    );
  }
  return {
    brief,
    script: scriptReport,
    scenes: report(
      'scenes',
      scenesChecks,
      Boolean(scenes && workflow.approvals.scenes === scenes.id),
      scriptReport.state === 'approved',
    ),
  };
}

export function approveWorkflow(workflow: Workflow, stage: WorkflowStage): Workflow {
  const verification = verifyWorkflow(workflow)[stage];
  if (!verification.canApprove) {
    throw new ApiError(
      409,
      'WORKFLOW_STAGE_BLOCKED',
      `Resolve the ${stage} verification issues before approving this stage.`,
      verification.checks
        .filter((item) => item.severity === 'error' && !item.passed)
        .map((item) => ({ path: item.path ?? stage, message: item.message })),
    );
  }
  const next = structuredClone(workflow);
  if (stage === 'brief') next.approvals.brief = next.contentRevision;
  else if (stage === 'script') next.approvals.script = next.script!.id;
  else next.approvals.scenes = next.scenes!.id;
  return next;
}

export function assertWorkflowGenerationAllowed(
  workflow: Workflow,
  stage: 'script' | 'scenes',
): void {
  const prior = stage === 'script' ? 'brief' : 'script';
  if (verifyWorkflow(workflow)[prior].state !== 'approved') {
    throw new ApiError(
      409,
      'APPROVAL_REQUIRED',
      `Approve the current ${prior} before generating ${stage}.`,
    );
  }
}

/** A single explicit final review approves all current artifacts; no approval is inferred by preparation. */
export function approveAllWorkflow(workflow: Workflow): Workflow {
  let next = approveWorkflow(workflow, 'brief');
  next = approveWorkflow(next, 'script');
  return approveWorkflow(next, 'scenes');
}

export interface WorkflowGenerationOptions {
  requireApproval?: boolean;
}

function assertArtifactValid(workflow: Workflow, stage: 'script' | 'scenes'): void {
  const verification = verifyWorkflow(workflow)[stage];
  const failures = verification.checks.filter((item) => item.severity === 'error' && !item.passed);
  if (failures.length)
    throw new ApiError(
      400,
      'WORKFLOW_VERIFICATION_FAILED',
      `The ${stage} artifact failed verification.`,
      failures.map((item) => ({ path: item.path ?? stage, message: item.message })),
    );
}

export function setWorkflowScript(
  workflow: Workflow,
  script: WorkflowScript,
  options: WorkflowGenerationOptions = {},
): Workflow {
  if (options.requireApproval !== false) assertWorkflowGenerationAllowed(workflow, 'script');
  const next = structuredClone(workflow);
  next.script = workflowScriptSchema.parse(script);
  next.scenes = null;
  next.approvals.script = null;
  next.approvals.scenes = null;
  assertArtifactValid(next, 'script');
  return next;
}

export function setWorkflowScenes(
  workflow: Workflow,
  scenes: WorkflowScenes,
  options: WorkflowGenerationOptions = {},
): Workflow {
  if (options.requireApproval !== false) assertWorkflowGenerationAllowed(workflow, 'scenes');
  const next = structuredClone(workflow);
  next.scenes = workflowScenesSchema.parse(scenes);
  next.approvals.scenes = null;
  assertArtifactValid(next, 'scenes');
  return next;
}

export function editWorkflowScript(
  workflow: Workflow,
  content: Omit<UpdateWorkflowScriptInput, 'expectedVersion'>,
): Workflow {
  if (!workflow.script)
    throw new ApiError(409, 'WORKFLOW_SCRIPT_REQUIRED', 'Generate a script before editing it.');
  return setWorkflowScript(
    workflow,
    {
      id: randomUUID(),
      sourceRevision: workflow.contentRevision,
      hook: content.hook,
      segments: content.segments,
      caption: content.caption,
      provider: workflow.script.provider,
      createdAt: new Date().toISOString(),
    },
    { requireApproval: false },
  );
}

export function editWorkflowScenes(
  workflow: Workflow,
  content: Omit<UpdateWorkflowScenesInput, 'expectedVersion'>,
): Workflow {
  if (!workflow.scenes || !workflow.script)
    throw new ApiError(409, 'WORKFLOW_SCENES_REQUIRED', 'Generate scenes before editing them.');
  return setWorkflowScenes(
    workflow,
    {
      id: randomUUID(),
      sourceScriptId: workflow.script.id,
      scenes: content.scenes,
      provider: workflow.scenes.provider,
      createdAt: new Date().toISOString(),
    },
    { requireApproval: false },
  );
}

function excerpt(text: string, wordLimit: number, charLimit = 1000): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const parts = normalized.split(' ');
  const words = parts.slice(0, Math.max(1, wordLimit)).join(' ');
  const clipped = words.slice(0, Math.max(1, charLimit - 1));
  return parts.length > wordLimit || words.length > clipped.length ? `${clipped}…` : clipped;
}

export function buildGuidedScript(
  workflow: Workflow,
  options: WorkflowGenerationOptions = {},
): WorkflowScript {
  if (options.requireApproval !== false) assertWorkflowGenerationAllowed(workflow, 'script');
  const briefReport = verifyWorkflow(workflow).brief;
  if (briefReport.state === 'blocked')
    throw new ApiError(
      409,
      'WORKFLOW_STAGE_BLOCKED',
      'Complete the required brief fields before preparing a script.',
    );
  const brief = workflow.brief;
  const duration = brief.duration!;
  const benefits = brief.keyBenefits ?? [brief.productDescription!];
  const count = Math.min(duration === 15 ? 3 : duration === 30 ? 4 : 6, benefits.length + 2);
  const baseSeconds = Math.floor(duration / count);
  const seconds = Array.from(
    { length: count },
    (_, index) => baseSeconds + (index < duration % count ? 1 : 0),
  );
  const hook = excerpt(
    `${brief.productName}: ${brief.productDescription}`,
    Math.max(4, seconds[0]! * 2),
    1000,
  );
  const text = [hook];
  for (let index = 0; index < count - 2; index += 1) {
    const start = Math.floor((index * benefits.length) / (count - 2));
    const end = Math.floor(((index + 1) * benefits.length) / (count - 2));
    text.push(
      excerpt(benefits.slice(start, end).join('. '), Math.max(4, seconds[index + 1]! * 2), 2000),
    );
  }
  text.push(excerpt(brief.callToAction!, Math.max(4, seconds[count - 1]! * 2), 2000));
  return workflowScriptSchema.parse({
    id: randomUUID(),
    sourceRevision: workflow.contentRevision,
    hook,
    segments: text.map((entry, index) => ({
      id: randomUUID(),
      text: entry,
      seconds: seconds[index]!,
    })),
    caption: `${excerpt(brief.productDescription!, 100, 1800)}\n\n${brief.callToAction}`,
    provider: 'guided',
    createdAt: new Date().toISOString(),
  });
}

export function buildGuidedScenes(
  workflow: Workflow,
  options: WorkflowGenerationOptions = {},
): WorkflowScenes {
  if (options.requireApproval !== false) assertWorkflowGenerationAllowed(workflow, 'scenes');
  const scriptReport = verifyWorkflow(workflow).script;
  if (scriptReport.state === 'blocked' || !workflow.script)
    throw new ApiError(
      409,
      'WORKFLOW_STAGE_BLOCKED',
      'Prepare a valid current script before preparing scenes.',
    );
  const script = workflow.script!;
  return workflowScenesSchema.parse({
    id: randomUUID(),
    sourceScriptId: script.id,
    scenes: script.segments.map((segment, index) => {
      const asset = workflow.assets[index % Math.max(1, workflow.assets.length)];
      const direction = workflow.brief.imageDirection
        ? ` Creator direction: ${excerpt(workflow.brief.imageDirection, 80, 900)}`
        : '';
      const visual = asset
        ? `Use supplied reference ${asset.filename}.${asset.description ? ` Creator description: ${excerpt(asset.description, 40, 500)}.` : ' Review its contents before filming.'}${direction}`
        : index === 0
          ? `Introduce ${workflow.brief.productName} on camera or with a product close view. Illustrate the approved opening segment.`
          : index === script.segments.length - 1
            ? 'Show a clear closing frame while the approved call to action is spoken.'
            : `Plan a shot illustrating this creator supplied detail: ${excerpt(segment.text, 40, 800)}`;
      return {
        id: randomUUID(),
        scriptSegmentId: segment.id,
        seconds: segment.seconds,
        visual,
        onScreenText: excerpt(segment.text, 8, 500),
        assetIds: asset ? [asset.id] : [],
      };
    }),
    provider: 'guided',
    createdAt: new Date().toISOString(),
  });
}

/** A read-only view of supplied facts and saved artifacts, not open-domain question answering. */
export function queryWorkflow(workflow: Workflow, question: string): WorkflowQueryResponse {
  const normalized = question.toLowerCase();
  const verification = verifyWorkflow(workflow);
  const evidence: WorkflowQueryEvidence[] = [];
  const openQuestions = buildQuestions(workflow).filter((item) => item.status === 'open');
  let answer: string;
  if (/image|photo|asset|picture|reference/.test(normalized)) {
    answer = workflow.assets.length
      ? `Attached references:\n${workflow.assets.map((asset) => `${asset.filename} (${asset.width}×${asset.height}): ${asset.description || 'No creator description supplied.'}`).join('\n')}\n\nImage direction: ${workflow.brief.imageDirection ?? 'Not supplied.'}\nThese are attachment metadata and creator descriptions. The guided engine has not interpreted image contents.`
      : 'No images are attached. You can upload product references, then describe how they should appear and which details to highlight.';
    evidence.push(...workflow.assets.map((asset) => ({ kind: 'asset' as const, id: asset.id })), {
      kind: 'brief',
      field: 'imageDirection',
    });
  } else if (/scene|shot|storyboard/.test(normalized)) {
    answer = workflow.scenes
      ? workflow.scenes.scenes
          .map((scene, index) => `Scene ${index + 1} (${scene.seconds}s): ${scene.visual}`)
          .join('\n\n')
      : 'There is no saved scene plan. Approve a current script, then generate scenes.';
    if (workflow.scenes)
      evidence.push(
        ...workflow.scenes.scenes.map((scene) => ({ kind: 'scene' as const, id: scene.id })),
      );
  } else if (/script|spoken|voiceover|hook/.test(normalized)) {
    answer = workflow.script
      ? `Hook: ${workflow.script.hook}\n\n${workflow.script.segments.map((segment, index) => `${index + 1}. (${segment.seconds}s) ${segment.text}`).join('\n\n')}`
      : 'There is no saved script. Complete and approve the brief, then generate a script.';
    if (workflow.script) evidence.push({ kind: 'script', id: workflow.script.id });
  } else if (/missing|question|next|ready|approv|verif|progress|status/.test(normalized)) {
    const blocked = (['brief', 'script', 'scenes'] as const).flatMap((stage) =>
      verification[stage].checks
        .filter((item) => !item.passed && item.severity === 'error')
        .map((item) => `${stage}: ${item.message}`),
    );
    answer = `Review status: brief ${verification.brief.state}; script ${verification.script.state}; scenes ${verification.scenes.state}.\n\n${blocked.length ? blocked.join('\n') : 'All stages are structurally ready. Explicit approval is still required for any stage marked needs_review.'}`;
    if (openQuestions.length)
      answer += `\n\nOpen questions:\n${openQuestions.map((item) => item.question).join('\n')}`;
    evidence.push({ kind: 'brief' });
    if (workflow.script) evidence.push({ kind: 'script', id: workflow.script.id });
    if (workflow.scenes) evidence.push({ kind: 'scene', id: workflow.scenes.id });
  } else {
    const details = Object.entries(workflow.brief).map(
      ([field, value]) => `${field}: ${Array.isArray(value) ? value.join('; ') : value}`,
    );
    answer = `Here is the saved information for this video:\n\n${details.join('\n')}\n\nThe initial request was: ${excerpt(workflow.input, 250, 3000)}\n\nThese are supplied details, not independently verified facts. You can ask about missing inputs, images, the script, or scenes, or submit a refinement to change the idea.`;
    evidence.push(
      ...Object.keys(workflow.brief).map((field) => ({ kind: 'brief' as const, field })),
    );
  }
  return workflowQueryResponseSchema.parse({
    answer: answer.slice(0, 12000),
    evidence,
    openQuestions,
    workflowVersion: workflow.version,
    provider: 'guided',
  });
}
