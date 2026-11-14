import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import express, { type Request, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  createCreatorSessionSchema,
  patchCreatorSessionSchema,
  creatorVersionRequestSchema,
  creatorPrepareSchema,
  creatorUpdatePlanSchema,
  creatorApproveSchema,
  creatorProduceSchema,
  creatorPlanSchema,
  type CreatorSession,
  type CreatorPlan,
  type CreatorClip,
} from '@yap/contracts/creator';
import { workflowBriefSchema, type Workflow, type WorkflowBrief } from '@yap/contracts/workflow';
import { ApiError } from './errors.js';
import { CreatorRepository } from './creator-repository.js';
import {
  productionProfile,
  buildCreatorQuote,
  quoteFingerprint,
  type CreatorBudgetLedger,
  type CreatorProductionProfile,
} from './creator-budget.js';
import { CreatorJobs, type CreatorAnalyzer } from './creator-jobs.js';
import {
  creatorVideoPrompt,
  type CreatorVideoConfig,
  type CreatorVideoProvider,
} from './creator-video-provider.js';
import {
  createConfiguredCreatorVideoProvider,
  creatorVideoConfigFromEnv,
} from './creator-video-factory.js';
import { createCreatorVisionAuditor, type CreatorVisionAuditor } from './creator-media.js';
import { analyzeCreator } from './creator-research.js';
import type { WorkflowRepository } from './workflow-repository.js';
import type { WorkflowAssetStore } from './workflow-assets.js';
import type { VideoWorkflowProvider } from './workflow-provider.js';
import {
  createWorkflow,
  buildQuestions,
  invalidateWorkflowContent,
  setWorkflowScript,
  setWorkflowScenes,
  approveAllWorkflow,
  verifyWorkflow,
} from './workflow-engine.js';

export interface CreatorRouterOptions {
  dataFile: string;
  directory: string;
  workflows: WorkflowRepository;
  assets: WorkflowAssetStore;
  provider: VideoWorkflowProvider;
  videoConfig?: CreatorVideoConfig;
  video?: CreatorVideoProvider;
  auditor?: CreatorVisionAuditor;
  analyze?: CreatorAnalyzer;
  fetch?: typeof globalThis.fetch;
  onError?: (error: unknown) => void;
  budgetLimitCents?: number;
  withBudget?: (ledger: CreatorBudgetLedger) => {
    analyze?: CreatorAnalyzer;
    provider?: VideoWorkflowProvider;
  };
}
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      'CREATOR_VALIDATION',
      'Check the creation details.',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  return result.data;
}
const idOf = (request: Request, key = 'id') => validate(z.uuid(), request.params[key]);
function ensurePlan(session: CreatorSession, workflow: Workflow): CreatorPlan {
  const plan = session.plan;
  if (
    !plan ||
    plan.workflowVersion !== workflow.version ||
    plan.scriptId !== workflow.script?.id ||
    plan.sourceScenesId !== workflow.scenes?.id
  )
    throw new ApiError(
      409,
      'CREATOR_PLAN_STALE',
      'Prepare the current script and clip parameters before reviewing this creation.',
    );
  return plan;
}
function validateClips(clips: CreatorClip[], workflow: Workflow): void {
  if (clips.reduce((total, clip) => total + clip.seconds, 0) !== workflow.brief.duration)
    throw new ApiError(
      400,
      'CREATOR_DURATION_MISMATCH',
      `Clip durations must add up to ${workflow.brief.duration} seconds.`,
    );
  if (new Set(clips.map((clip) => clip.id)).size !== clips.length)
    throw new ApiError(400, 'CREATOR_DUPLICATE_CLIP', 'Each clip requires its own ID.');
  const scenes = new Set(workflow.scenes?.scenes.map((scene) => scene.id)),
    assets = new Set(workflow.assets.map((asset) => asset.id));
  if (workflow.scenes?.scenes.some((scene) => !clips.some((clip) => clip.sceneId === scene.id)))
    throw new ApiError(
      400,
      'CREATOR_SCENE_COVERAGE',
      'Include at least one clip for each current scene.',
    );
  for (const clip of clips) {
    if (!scenes.has(clip.sceneId) || (clip.assetId && !assets.has(clip.assetId)))
      throw new ApiError(
        400,
        'CREATOR_REFERENCE_MISSING',
        'Every clip must reference a current scene and an uploaded photo when supplied.',
      );
    if (creatorVideoPrompt(clip).length > 1000)
      throw new ApiError(
        400,
        'CREATOR_PROMPT_TOO_LONG',
        'Keep each combined visual, camera and lighting prompt within 1,000 characters.',
      );
  }
}
function makePlan(
  session: CreatorSession,
  workflow: Workflow,
  profile: CreatorProductionProfile,
): CreatorPlan {
  if (!workflow.script || !workflow.scenes)
    throw new ApiError(409, 'CREATOR_SCRIPT_REQUIRED', 'Prepare a script and scene plan first.');
  const scenes = workflow.scenes.scenes,
    total = workflow.brief.duration!;
  const parts = scenes.flatMap((scene) => {
    if (scene.seconds < profile.minSeconds)
      throw new ApiError(
        400,
        'CREATOR_SCENE_TOO_SHORT',
        'This provider cannot generate such a short scene. Combine it or adjust its timing before preparing clips.',
      );
    const count = Math.ceil(scene.seconds / profile.maxSeconds),
      base = Math.floor(scene.seconds / count);
    return Array.from({ length: count }, (_, index) => ({
      scene,
      seconds: base + (index < scene.seconds % count ? 1 : 0),
    }));
  });
  if (parts.length > 12)
    throw new ApiError(
      400,
      'CREATOR_CLIP_LIMIT',
      'This production supports at most twelve short clips. Combine some scenes before preparing clips.',
    );
  const count = parts.length;
  const selected =
    session.research?.references.filter((reference) =>
      session.selectedReferenceIds.includes(reference.id),
    ) ?? [];
  const references = [
    ...selected.map((reference) => ({ id: reference.id, direction: reference.visualDirection })),
    ...session.externalReferences.map((reference) => ({
      id: reference.id,
      direction: reference.techniques.join('; '),
    })),
  ];
  const location =
    session.answers.find((answer) => answer.questionId === 'location')?.answer ??
    session.input.location;
  const place =
    Boolean(location) ||
    /\b(place|restaurant|cafe|café|hotel|location|travel|store|venue)\b/i.test(
      session.input.prompt,
    );
  const software =
    session.input.urls.some((url) => new URL(url).hostname === 'github.com') ||
    /\b(software|app|website|saas|github)\b/i.test(session.input.prompt);
  const clips: CreatorClip[] = parts.map(({ scene, seconds }, index) => {
    const reference = references[index % Math.max(1, references.length)];
    const image = workflow.assets.find((asset) => asset.id === scene.assetIds[0]);
    return {
      id: randomUUID(),
      sceneId: scene.id,
      seconds,
      prompt:
        `${image ? `Preserve the supplied reference image. ${image.description.slice(0, 120)}. ` : `Subject: ${workflow.brief.productDescription?.slice(0, 180)}. `}${location ? `Creator location: ${location.slice(0, 100)}. ` : ''}${software ? 'Use abstract software-inspired forms; do not invent readable UI or functionality. ' : ''}${scene.visual.slice(0, 150)}${reference ? ` Creative technique only: ${reference.direction.slice(0, 100)}. Do not reproduce reference brands.` : ''}`.slice(
          0,
          580,
        ),
      camera: place
        ? index === 0
          ? 'Wide spatial establishing shot, slow cinematic push in.'
          : 'Slow architectural tracking shot, grounded human-scale perspective.'
        : software
          ? 'Controlled studio camera around sculptural software-inspired forms, clean negative space.'
          : index === 0
            ? 'Controlled close product detail, slow push in, shallow depth of field.'
            : index === count - 1
              ? 'Smooth pull back to a composed product hero frame.'
              : 'Slow lateral tracking shot with stable subject framing.',
      lighting: place
        ? 'Natural location light, motivated practical highlights, restrained contrast.'
        : 'Sculpted soft key light, restrained contrast, natural subject color.',
      ...(image ? { assetId: image.id } : {}),
      referenceIds: reference ? [reference.id] : [],
    };
  });
  validateClips(clips, workflow);
  return creatorPlanSchema.parse({
    id: randomUUID(),
    workflowVersion: workflow.version,
    scriptId: workflow.script.id,
    sourceScenesId: workflow.scenes.id,
    caption: workflow.script.caption,
    clips,
    provider: profile.provider,
    model: profile.model,
    ratio: '720:1280',
    hasAudio: false,
    maxAttemptsPerClip: 2,
    maxGeneratedSeconds: total * 2,
    createdAt: new Date().toISOString(),
  });
}
export async function createCreatorRouter(options: CreatorRouterOptions) {
  const repository = await CreatorRepository.open(resolve(options.dataFile), {
    limitCents: options.budgetLimitCents,
  });
  const budgeted = options.withBudget?.(repository);
  const draftingProvider = budgeted?.provider ?? options.provider;
  const video =
    options.video ??
    createConfiguredCreatorVideoProvider(
      { ...creatorVideoConfigFromEnv(), ...options.videoConfig },
      options.fetch,
    );
  const auditor =
    options.auditor ??
    createCreatorVisionAuditor(
      { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL },
      options.fetch,
    );
  const jobs = new CreatorJobs({
    repository,
    workflows: options.workflows,
    assets: options.assets,
    directory: resolve(options.directory),
    video,
    auditor,
    analyze:
      budgeted?.analyze ??
      options.analyze ??
      (async (...args) => {
        if (process.env.FIRECRAWL_API_KEY?.trim())
          throw new ApiError(
            503,
            'CREATOR_BUDGET_CONFIGURATION',
            'Live creator research requires the shared spending ledger.',
          );
        return analyzeCreator(...args);
      }),
    onError: options.onError,
  });
  const router = express.Router();
  const envelope = async (session: CreatorSession) => ({
    session,
    workflow: await options.workflows.get(session.workflowId),
  });
  const locked =
    (handler: (request: Request, response: Response) => Promise<unknown>): RequestHandler =>
    async (request, response) => {
      await repository.withSession(idOf(request), () => handler(request, response));
    };
  router.use((_request, response, next) => {
    const controller = new AbortController();
    response.locals.creatorSignal = controller.signal;
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    next();
  });
  router.get('/capabilities', (_request, response) =>
    response.json({
      configured: video.configured,
      researchConfigured: Boolean(options.analyze || process.env.FIRECRAWL_API_KEY?.trim()),
      visionConfigured: auditor.configured,
      provider: productionProfile(video).provider,
      model: productionProfile(video).model,
      hasAudio: false,
      maxAttemptsPerClip: 2,
      maxGeneratedSeconds: 120,
      reason: !video.configured
        ? `Configure ${productionProfile(video).provider === 'fal' ? 'FAL_KEY' : 'RUNWAYML_API_SECRET'} for real paid video generation.`
        : !auditor.configured
          ? 'Configure OPENAI_API_KEY for the required generated-frame review.'
          : 'Paid generation and sampled-frame review are configured. Cancellation is best effort; submitted provider tasks may continue and be billed.',
    }),
  );
  router.get('/sessions', async (_request, response) =>
    response.json({ sessions: await repository.list() }),
  );
  router.post('/sessions', async (request, response) => {
    const input = validate(createCreatorSessionSchema, request.body);
    const workflow = input.workflowId
      ? await options.workflows.get(input.workflowId)
      : await options.workflows.create(
          createWorkflow({
            input: input.input.prompt,
            research: input.research,
            brief: {
              duration: input.input.duration ?? 15,
              ...(input.input.platform ? { platform: input.input.platform } : {}),
              ...(input.input.tone ? { tone: input.input.tone } : {}),
            },
          }),
        );
    const now = new Date().toISOString();
    const session = await repository.create({
      id: randomUUID(),
      version: 1,
      workflowId: workflow.id,
      input: input.input,
      answers: [],
      research: null,
      selectedReferenceIds: [],
      externalReferences: input.externalReferences ?? [],
      plan: null,
      approval: null,
      createdAt: now,
      updatedAt: now,
    });
    response
      .status(201)
      .location(`/api/creator/sessions/${session.id}`)
      .json({ session, workflow });
  });
  router.get('/sessions/:id', async (request, response) =>
    response.json(await envelope(await repository.get(idOf(request)))),
  );
  router.patch(
    '/sessions/:id',
    locked(async (request, response) => {
      const input = validate(patchCreatorSessionSchema, request.body),
        { expectedVersion, ...changes } = input;
      const session = await repository.update(idOf(request), expectedVersion, (current) => {
        if (
          changes.selectedReferenceIds &&
          changes.selectedReferenceIds.some(
            (id) => !current.research?.references.some((reference) => reference.id === id),
          )
        )
          throw new ApiError(
            400,
            'CREATOR_REFERENCE_NOT_FOUND',
            'Select references from this creation research.',
          );
        if (
          changes.answers &&
          new Set(changes.answers.map((answer) => answer.questionId)).size !==
            changes.answers.length
        )
          throw new ApiError(
            400,
            'CREATOR_DUPLICATE_ANSWER',
            'Save one answer for each interview question.',
          );
        const inputChanged =
          changes.input && JSON.stringify(changes.input) !== JSON.stringify(current.input);
        return {
          ...current,
          ...changes,
          ...(inputChanged ? { research: null, selectedReferenceIds: [] } : {}),
          plan: null,
          approval: null,
        };
      });
      response.json(await envelope(session));
    }),
  );
  router.post('/sessions/:id/analyze', async (request, response) => {
    const input = validate(creatorVersionRequestSchema, request.body),
      session = await repository.get(idOf(request));
    repository.checkVersion(session, input.expectedVersion);
    const workflow = await options.workflows.get(session.workflowId);
    response.status(202).json({ job: await jobs.startAnalysis(session, workflow), session });
  });
  router.post(
    '/sessions/:id/prepare',
    locked(async (request, response) => {
      const input = validate(creatorPrepareSchema, request.body),
        session = await repository.get(idOf(request));
      repository.checkVersion(session, input.expectedVersion);
      const previous = await options.workflows.get(session.workflowId);
      options.workflows.checkVersion(previous, input.expectedWorkflowVersion);
      const brief: WorkflowBrief = { ...previous.brief };
      if (previous.input !== session.input.prompt)
        brief.productDescription = session.input.prompt.slice(0, 4000);
      if (session.input.platform) brief.platform = session.input.platform;
      if (session.input.duration) brief.duration = session.input.duration;
      if (session.input.tone) brief.tone = session.input.tone;
      for (const answer of session.answers) {
        if (answer.questionId === 'keyBenefits')
          brief.keyBenefits = answer.answer
            .split(/[;\n]+/)
            .map((part) => part.trim())
            .filter(Boolean)
            .slice(0, 10);
        else if (
          [
            'productName',
            'productDescription',
            'audience',
            'callToAction',
            'imageDirection',
          ].includes(answer.questionId)
        )
          Object.assign(brief, { [answer.questionId]: answer.answer });
        else if (answer.questionId === 'style' && !brief.imageDirection?.includes(answer.answer))
          brief.imageDirection = [brief.imageDirection, answer.answer]
            .filter(Boolean)
            .join('\n')
            .slice(0, 2000);
      }
      const factsChanged =
        previous.input !== session.input.prompt ||
        JSON.stringify(brief) !== JSON.stringify(previous.brief);
      validate(workflowBriefSchema, brief);
      let candidate = factsChanged
        ? invalidateWorkflowContent({ ...previous, input: session.input.prompt, brief })
        : structuredClone(previous);
      candidate.questions = buildQuestions(candidate);
      const selected =
        session.research?.references.filter((reference) =>
          session.selectedReferenceIds.includes(reference.id),
        ) ?? [];
      const citations = [
        ...selected.flatMap((reference) =>
          reference.sourceIds
            .map((id) => session.research?.sources.find((source) => source.id === id)?.url)
            .filter((value): value is string => Boolean(value)),
        ),
        ...session.externalReferences.map((reference) => reference.url),
      ];
      const technique = [
        ...selected.map((reference) => reference.visualDirection),
        ...session.externalReferences.map((reference) => reference.techniques.join('; ')),
      ].join('\n');
      const location =
        session.answers.find((answer) => answer.questionId === 'location')?.answer ??
        session.input.location;
      const selectedProfessional = selected
        .flatMap((reference) => reference.sourceIds)
        .map(
          (id) =>
            session.research?.sources.find(
              (source) => source.id === id && source.kind === 'cinematography',
            )?.excerpt,
        )
        .filter(Boolean)
        .join('\n');
      const context =
        `${candidate.brief.imageDirection ?? ''}\n${location ? `Creator-supplied location: ${location}. Use a place/architecture establishing shot where appropriate.\n` : ''}Selected creative techniques, not product facts: ${technique}\nSelected professional cinematography: ${selectedProfessional}\nSource URLs: ${citations.join(' ')}`.slice(
          0,
          2000,
        );
      const signal = response.locals.creatorSignal as AbortSignal;
      if (draftingProvider.name === 'openai' && !budgeted?.provider)
        throw new ApiError(
          503,
          'CREATOR_BUDGET_CONFIGURATION',
          'Creator drafting requires the shared spending ledger.',
        );
      if (!candidate.script)
        candidate = setWorkflowScript(
          candidate,
          await draftingProvider.script(
            { ...candidate, brief: { ...candidate.brief, imageDirection: context } },
            signal,
          ),
          { requireApproval: false },
        );
      if (!candidate.scenes)
        candidate = setWorkflowScenes(
          candidate,
          await draftingProvider.scenes(
            { ...candidate, brief: { ...candidate.brief, imageDirection: context } },
            signal,
          ),
          { requireApproval: false },
        );
      if (citations.length && candidate.scenes)
        candidate.scenes.scenes = candidate.scenes.scenes.map((scene) => ({
          ...scene,
          visual:
            `${scene.visual.slice(0, 1100)}\nCreative reference attribution only: ${citations.join(' ')}`.slice(
              0,
              2000,
            ),
        }));
      signal.throwIfAborted();
      repository.checkVersion(await repository.get(session.id), input.expectedVersion);
      const plan = makePlan(
        session,
        { ...candidate, version: previous.version + 1 },
        productionProfile(video),
      );
      const workflow = await options.workflows.update(
        previous.id,
        previous.version,
        () => candidate,
      );
      const saved = await repository.update(session.id, session.version, (current) => ({
        ...current,
        plan,
        approval: null,
      }));
      response.json({ session: saved, workflow });
    }),
  );
  router.patch(
    '/sessions/:id/plan',
    locked(async (request, response) => {
      const input = validate(creatorUpdatePlanSchema, request.body),
        session = await repository.get(idOf(request));
      repository.checkVersion(session, input.expectedVersion);
      let workflow = await options.workflows.get(session.workflowId);
      options.workflows.checkVersion(workflow, input.expectedWorkflowVersion);
      const plan = ensurePlan(session, workflow);
      validateClips(input.clips, workflow);
      const allowedReferences = new Set([
        ...session.selectedReferenceIds,
        ...session.externalReferences.map((reference) => reference.id),
      ]);
      if (input.clips.some((clip) => clip.referenceIds?.some((id) => !allowedReferences.has(id))))
        throw new ApiError(
          400,
          'CREATOR_REFERENCE_NOT_FOUND',
          'Use selected creative reference IDs only.',
        );
      const secondsByScene = new Map<string, number>();
      for (const clip of input.clips)
        secondsByScene.set(clip.sceneId, (secondsByScene.get(clip.sceneId) ?? 0) + clip.seconds);
      const timingChanged = workflow.scenes!.scenes.some(
        (scene) => secondsByScene.get(scene.id) !== scene.seconds,
      );
      if (input.caption !== workflow.script!.caption || timingChanged) {
        workflow = await options.workflows.update(workflow.id, workflow.version, (current) => {
          const scenes = current.scenes!.scenes.map((scene) => ({
            ...scene,
            seconds: secondsByScene.get(scene.id)!,
          }));
          current.script = {
            ...current.script!,
            id: randomUUID(),
            caption: input.caption,
            segments: current.script!.segments.map((segment) => ({
              ...segment,
              seconds: scenes
                .filter((scene) => scene.scriptSegmentId === segment.id)
                .reduce((total, scene) => total + scene.seconds, 0),
            })),
            createdAt: new Date().toISOString(),
          };
          current.scenes = {
            ...current.scenes!,
            id: randomUUID(),
            sourceScriptId: current.script.id,
            scenes,
            createdAt: new Date().toISOString(),
          };
          current.approvals = { brief: null, script: null, scenes: null };
          return current;
        });
      }
      const saved = await repository.update(session.id, session.version, (current) => ({
        ...current,
        approval: null,
        plan: {
          ...plan,
          id: randomUUID(),
          workflowVersion: workflow.version,
          scriptId: workflow.script!.id,
          sourceScenesId: workflow.scenes!.id,
          caption: input.caption,
          clips: input.clips,
          maxGeneratedSeconds: input.clips.reduce((total, clip) => total + clip.seconds, 0) * 2,
        },
      }));
      response.json({ session: saved, workflow });
    }),
  );
  router.get('/budget', async (_request, response) =>
    response.json({ budget: await repository.budget() }),
  );
  router.post(
    '/sessions/:id/quote',
    locked(async (request, response) => {
      const input = validate(creatorPrepareSchema, request.body);
      const session = await repository.get(idOf(request));
      repository.checkVersion(session, input.expectedVersion);
      const workflow = await options.workflows.get(session.workflowId);
      options.workflows.checkVersion(workflow, input.expectedWorkflowVersion);
      ensurePlan(session, workflow);
      validateClips(session.plan!.clips, workflow);
      const history = await repository.jobs(session.id);
      if (history.some((job) => job.status === 'queued' || job.status === 'running'))
        throw new ApiError(
          409,
          'CREATOR_JOB_ACTIVE',
          'Wait for the current job before reviewing another paid quote.',
        );
      const quote = buildCreatorQuote(session, workflow, productionProfile(video), history);
      for (const item of quote.clips)
        if (item.reuse) {
          const oldJob = await repository.job(session.id, item.reuse.jobId);
          await jobs.verifyClip(oldJob, item.clipId, item.reuse.attempt);
        }
      response.json({ quote: await repository.addQuote(quote), budget: await repository.budget() });
    }),
  );
  router.post(
    '/sessions/:id/approve',
    locked(async (request, response) => {
      const input = validate(creatorApproveSchema, request.body);
      const session = await repository.get(idOf(request));
      repository.checkVersion(session, input.expectedVersion);
      let workflow = await options.workflows.get(session.workflowId);
      options.workflows.checkVersion(workflow, input.expectedWorkflowVersion);
      const plan = ensurePlan(session, workflow);
      const quote = await repository.quote(input.quoteId);
      if (
        quote.sessionId !== session.id ||
        quote.sessionVersion !== session.version ||
        quote.workflowVersion !== workflow.version ||
        quote.planId !== input.planId ||
        quote.planId !== plan.id ||
        quote.fingerprint !== quoteFingerprint(session, workflow, productionProfile(video))
      )
        throw new ApiError(
          409,
          'CREATOR_QUOTE_STALE',
          'The plan, references or provider changed. Review a new cost quote.',
        );
      if (
        quote.consumedByJobId ||
        quote.approvedApprovalId ||
        Date.parse(quote.expiresAt) <= Date.now()
      )
        throw new ApiError(409, 'CREATOR_QUOTE_EXPIRED', 'Request and review a fresh cost quote.');
      validateClips(plan.clips, workflow);
      if (quote.maxCostCents > (await repository.budget()).availableCents)
        throw new ApiError(
          409,
          'CREATOR_BUDGET_EXCEEDED',
          'This quote exceeds the remaining creator budget.',
        );
      if (Object.values(verifyWorkflow(workflow)).some((report) => report.state !== 'approved'))
        workflow = await options.workflows.update(
          workflow.id,
          workflow.version,
          approveAllWorkflow,
        );
      const saved = await repository.approveQuote(
        {
          ...session,
          plan: { ...plan, workflowVersion: workflow.version },
          approval: {
            id: randomUUID(),
            planId: plan.id,
            workflowVersion: workflow.version,
            quoteId: quote.id,
            approvedAt: new Date().toISOString(),
          },
        },
        session.version,
        quote.id,
      );
      response.json({ session: saved, workflow });
    }),
  );
  router.post('/sessions/:id/produce', async (request, response) => {
    const input = validate(creatorProduceSchema, request.body),
      session = await repository.get(idOf(request));
    const existing = (await repository.jobs(session.id)).find(
      (job) => job.requestId === input.requestId,
    );
    if (existing) {
      if (
        existing.kind !== 'production' ||
        existing.approvalId !== input.approvalId ||
        existing.quoteId !== input.quoteId
      )
        throw new ApiError(
          409,
          'CREATOR_REQUEST_CONFLICT',
          'This request belongs to another operation.',
        );
      response.status(202).json({ job: existing, session });
      return;
    }
    repository.checkVersion(session, input.expectedVersion);
    if (session.approval?.id !== input.approvalId || session.approval.quoteId !== input.quoteId)
      throw new ApiError(
        409,
        'CREATOR_APPROVAL_REQUIRED',
        'Approve this exact plan and paid budget first.',
      );
    const workflow = await options.workflows.get(session.workflowId);
    response
      .status(202)
      .json({ job: await jobs.startProduction(session, workflow, input.requestId), session });
  });
  router.get('/sessions/:id/jobs', async (request, response) =>
    response.json({ jobs: await repository.jobs(idOf(request)) }),
  );
  router.get('/sessions/:id/jobs/:jobId', async (request, response) => {
    const id = idOf(request);
    response.json({
      job: await repository.job(id, idOf(request, 'jobId')),
      session: await repository.get(id),
    });
  });
  router.delete('/sessions/:id/jobs/:jobId', async (request, response) => {
    const id = idOf(request);
    response.json({
      job: await jobs.cancel(id, idOf(request, 'jobId')),
      session: await repository.get(id),
    });
  });
  router.get('/sessions/:id/jobs/:jobId/clips/:clipId/video', async (request, response, next) => {
    const job = await repository.job(idOf(request), idOf(request, 'jobId')),
      clipId = idOf(request, 'clipId'),
      attempt = validate(z.coerce.number().int().min(1).max(2), request.query.attempt ?? 1);
    if (
      !job.clips.some(
        (clip) => clip.clipId === clipId && clip.attempt === attempt && clip.status === 'passed',
      )
    )
      throw new ApiError(
        409,
        'CREATOR_CLIP_NOT_READY',
        'This clip has not passed the required review.',
      );
    response.type('video/mp4').sendFile(await jobs.verifyClip(job, clipId, attempt), (error) => {
      if (error) next(error);
    });
  });
  router.get('/sessions/:id/jobs/:jobId/video', async (request, response, next) => {
    const session = await repository.get(idOf(request)),
      job = await repository.job(session.id, idOf(request, 'jobId')),
      workflow = await options.workflows.get(session.workflowId);
    if (job.approvalId !== session.approval?.id || job.workflowVersion !== workflow.version)
      throw new ApiError(
        409,
        'CREATOR_VIDEO_STALE',
        'This video belongs to an older approval. Review the current creation before publishing.',
      );
    const path = await jobs.verifyOutput(job);
    response.type('video/mp4');
    if (request.query.download === '1') response.attachment('yap-creation.mp4');
    response.sendFile(path, (error) => {
      if (error) next(error);
    });
  });
  return {
    router,
    repository,
    budget: repository as CreatorBudgetLedger,
    jobs,
    close: () => jobs.close(),
  };
}
