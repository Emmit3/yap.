import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import express, { type Request } from 'express';
import { z } from 'zod';
import {
  approveWorkflowStageSchema,
  createWorkflowSchema,
  generateWorkflowSchema,
  prepareWorkflowSchema,
  queryWorkflowSchema,
  refineWorkflowSchema,
  updateAssetDescriptionSchema,
  updateWorkflowScenesSchema,
  updateWorkflowScriptSchema,
  workflowBriefSchema,
  type Workflow,
} from '@yap/contracts/workflow';
import { renderRequestSchema } from '@yap/contracts/render';
import { ApiError } from './errors.js';
import {
  approveAllWorkflow,
  approveWorkflow,
  assertWorkflowGenerationAllowed,
  buildQuestions,
  createWorkflow,
  editWorkflowScenes,
  editWorkflowScript,
  invalidateWorkflowContent,
  refineWorkflow,
  setWorkflowScenes,
  setWorkflowScript,
  verifyWorkflow,
} from './workflow-engine.js';
import { WorkflowAssetStore } from './workflow-assets.js';
import { WorkflowRepository } from './workflow-repository.js';
import {
  createWorkflowProvider,
  type VideoWorkflowProvider,
  type WorkflowProviderConfig,
} from './workflow-provider.js';
import { VideoRenderQueue, type PromoRenderer } from './video-render-queue.js';

export interface WorkflowRouterOptions {
  dataFile: string;
  assetsDirectory: string;
  rendersDirectory: string;
  providerConfig?: WorkflowProviderConfig;
  provider?: VideoWorkflowProvider;
  renderer?: PromoRenderer;
  onError?: (error: unknown) => void;
}

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Check the promo details and try again.',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  return parsed.data;
}
function uuid(value: unknown): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success)
    throw new ApiError(400, 'INVALID_WORKFLOW_ID', 'Use a valid workflow, photo, or render ID.');
  return parsed.data;
}
function versionQuery(request: Request): number {
  return validated(
    z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    request.query.expectedVersion,
  );
}
function filename(request: Request): string {
  const value = request.get('X-File-Name');
  if (!value) return 'photo';
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(
      400,
      'INVALID_IMAGE_FILENAME',
      'Encode the photo filename with encodeURIComponent.',
    );
  }
}
const envelope = (workflow: Workflow) => ({ workflow, verification: verifyWorkflow(workflow) });

function assistantMessage(workflow: Workflow, text: string): Workflow {
  return {
    ...workflow,
    questions: buildQuestions(workflow),
    messages: [
      ...workflow.messages,
      {
        id: randomUUID(),
        role: 'assistant' as const,
        kind: 'refinement' as const,
        text,
        createdAt: new Date().toISOString(),
      },
    ].slice(-200),
  };
}

export async function createWorkflowRouter(options: WorkflowRouterOptions) {
  const repository = await WorkflowRepository.open(resolve(options.dataFile));
  const assets = new WorkflowAssetStore(resolve(options.assetsDirectory));
  const provider =
    options.provider ??
    createWorkflowProvider(options.providerConfig ?? { provider: 'guided' }, {
      loadAsset: async (workflowId, asset) => ({
        mimeType: asset.mimeType,
        data: await assets.load(workflowId, asset),
      }),
    });
  const renders = new VideoRenderQueue(
    repository,
    assets,
    resolve(options.rendersDirectory),
    options.renderer,
    options.onError,
  );
  await renders.recoverInterrupted();
  const router = express.Router();
  router.use((_request, response, next) => {
    const controller = new AbortController();
    response.locals.workflowSignal = controller.signal;
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    next();
  });
  router.param('id', (_request, _response, next, value) => {
    try {
      uuid(value);
      next();
    } catch (error) {
      next(error);
    }
  });
  router.param('assetId', (_request, _response, next, value) => {
    try {
      uuid(value);
      next();
    } catch (error) {
      next(error);
    }
  });
  router.param('jobId', (_request, _response, next, value) => {
    try {
      uuid(value);
      next();
    } catch (error) {
      next(error);
    }
  });
  const idOf = (request: Request) => uuid(request.params.id);

  router.get('/capabilities', (_request, response) =>
    response.json({
      provider: provider.name,
      understandsImages: provider.name === 'openai',
      images: {
        contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
        maxBytes: 10 * 1024 * 1024,
        maxCount: 20,
      },
      video: { contentType: 'video/mp4', width: 1080, height: 1920, fps: 24, hasAudio: false },
      approvalRequired: true,
      automaticPosting: false,
    }),
  );

  router.get('/', async (request, response) => {
    const q = validated(z.string().trim().max(200).optional(), request.query.q)?.toLowerCase();
    const workflows = await repository.list();
    response.json({
      workflows: q
        ? workflows.filter((item) =>
            JSON.stringify({
              title: item.title,
              input: item.input,
              brief: item.brief,
              messages: item.messages,
              script: item.script,
              scenes: item.scenes,
            })
              .toLowerCase()
              .includes(q),
          )
        : workflows,
    });
  });
  router.post('/', async (request, response) => {
    const workflow = await repository.create(
      createWorkflow(validated(createWorkflowSchema, request.body)),
    );
    response.status(201).location(`/api/workflows/${workflow.id}`).json(envelope(workflow));
  });
  router.get('/:id', async (request, response) => {
    response.json(envelope(await repository.get(idOf(request))));
  });
  router.get('/:id/verification', async (request, response) => {
    response.json({ verification: verifyWorkflow(await repository.get(idOf(request))) });
  });
  router.get('/:id/history', async (request, response) => {
    response.json({ history: await repository.history(idOf(request)) });
  });
  router.post('/:id/query', async (request, response) => {
    const { question } = validated(queryWorkflowSchema, request.body);
    response.json(
      await provider.query(
        await repository.get(idOf(request)),
        question,
        response.locals.workflowSignal,
      ),
    );
  });

  router.post('/:id/refine', async (request, response) => {
    const input = validated(refineWorkflowSchema, request.body);
    const previous = await repository.get(idOf(request));
    repository.checkVersion(previous, input.expectedVersion);
    let candidate = refineWorkflow(previous, input);
    const researchOnly =
      input.research !== undefined &&
      input.message === undefined &&
      input.answers === undefined &&
      input.brief === undefined;
    if (!researchOnly) {
      const result = await provider.refine(candidate, input, response.locals.workflowSignal);
      if (Object.keys(result.brief).length) {
        // Explicit form answers remain authoritative over a model's suggested patch.
        const suggestions = { ...result.brief };
        for (const field of Object.keys(input.answers ?? {}))
          delete suggestions[field as keyof typeof suggestions];
        candidate = refineWorkflow(previous, {
          ...input,
          brief: { ...suggestions, ...input.brief },
        });
      }
      candidate = assistantMessage(candidate, result.message);
    }
    response.json(
      envelope(await repository.update(previous.id, input.expectedVersion, () => candidate)),
    );
  });
  router.post('/:id/prepare', async (request, response) => {
    const { expectedVersion, regenerate } = validated(prepareWorkflowSchema, request.body);
    const previous = await repository.get(idOf(request));
    repository.checkVersion(previous, expectedVersion);
    let candidate = structuredClone(previous);
    if (provider.name === 'openai' && (!candidate.script || regenerate)) {
      const result = await provider.refine(candidate, {}, response.locals.workflowSignal);
      const brief = workflowBriefSchema.parse({ ...candidate.brief, ...result.brief });
      if (JSON.stringify(brief) !== JSON.stringify(candidate.brief)) {
        candidate.brief = brief;
        candidate = invalidateWorkflowContent(candidate);
      }
      candidate = assistantMessage(candidate, result.message);
    }
    if (
      regenerate ||
      !candidate.script ||
      candidate.script.sourceRevision !== candidate.contentRevision
    ) {
      candidate = setWorkflowScript(
        candidate,
        await provider.script(candidate, response.locals.workflowSignal),
        { requireApproval: false },
      );
    }
    if (
      regenerate ||
      !candidate.scenes ||
      candidate.scenes.sourceScriptId !== candidate.script!.id
    ) {
      candidate = setWorkflowScenes(
        candidate,
        await provider.scenes(candidate, response.locals.workflowSignal),
        { requireApproval: false },
      );
    }
    if (JSON.stringify(candidate) === JSON.stringify(previous)) {
      response.json(envelope(previous));
      return;
    }
    response.json(envelope(await repository.update(previous.id, expectedVersion, () => candidate)));
  });
  router.post('/:id/approve-all', async (request, response) => {
    const { expectedVersion } = validated(generateWorkflowSchema, request.body);
    response.json(
      envelope(await repository.update(idOf(request), expectedVersion, approveAllWorkflow)),
    );
  });
  router.post('/:id/approve', async (request, response) => {
    const { expectedVersion, stage } = validated(approveWorkflowStageSchema, request.body);
    response.json(
      envelope(
        await repository.update(idOf(request), expectedVersion, (workflow) =>
          approveWorkflow(workflow, stage),
        ),
      ),
    );
  });
  router.post('/:id/script/generate', async (request, response) => {
    const { expectedVersion } = validated(generateWorkflowSchema, request.body);
    const previous = await repository.get(idOf(request));
    repository.checkVersion(previous, expectedVersion);
    assertWorkflowGenerationAllowed(previous, 'script');
    const script = await provider.script(previous, response.locals.workflowSignal);
    response.json(
      envelope(
        await repository.update(previous.id, expectedVersion, (workflow) =>
          setWorkflowScript(workflow, script),
        ),
      ),
    );
  });
  router.patch('/:id/script', async (request, response) => {
    const input = validated(updateWorkflowScriptSchema, request.body);
    response.json(
      envelope(
        await repository.update(idOf(request), input.expectedVersion, (workflow) =>
          editWorkflowScript(workflow, input),
        ),
      ),
    );
  });
  router.post('/:id/scenes/generate', async (request, response) => {
    const { expectedVersion } = validated(generateWorkflowSchema, request.body);
    const previous = await repository.get(idOf(request));
    repository.checkVersion(previous, expectedVersion);
    assertWorkflowGenerationAllowed(previous, 'scenes');
    const scenes = await provider.scenes(previous, response.locals.workflowSignal);
    response.json(
      envelope(
        await repository.update(previous.id, expectedVersion, (workflow) =>
          setWorkflowScenes(workflow, scenes),
        ),
      ),
    );
  });
  router.post('/:id/scenes/prepare', async (request, response) => {
    const { expectedVersion } = validated(generateWorkflowSchema, request.body);
    const previous = await repository.get(idOf(request));
    repository.checkVersion(previous, expectedVersion);
    if (!previous.script)
      throw new ApiError(
        409,
        'SCRIPT_REQUIRED',
        'Prepare or write a script before proposing its scenes.',
      );
    const scenes = await provider.scenes(previous, response.locals.workflowSignal);
    response.json(
      envelope(
        await repository.update(previous.id, expectedVersion, (workflow) =>
          setWorkflowScenes(workflow, scenes, { requireApproval: false }),
        ),
      ),
    );
  });
  router.patch('/:id/scenes', async (request, response) => {
    const input = validated(updateWorkflowScenesSchema, request.body);
    response.json(
      envelope(
        await repository.update(idOf(request), input.expectedVersion, (workflow) =>
          editWorkflowScenes(workflow, input),
        ),
      ),
    );
  });

  router.post(
    '/:id/assets',
    express.raw({
      type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'],
      limit: '10mb',
    }),
    async (request, response) => {
      const id = idOf(request),
        expectedVersion = versionQuery(request);
      const workflow = await repository.get(id);
      repository.checkVersion(workflow, expectedVersion);
      if (workflow.assets.length >= 20)
        throw new ApiError(
          409,
          'PHOTO_LIMIT',
          'Use up to 20 photos per promo. Remove a photo before uploading another.',
        );
      const mimeType = request.get('Content-Type')?.split(';')[0]?.trim();
      if (!mimeType || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType))
        throw new ApiError(
          415,
          'UNSUPPORTED_IMAGE_TYPE',
          'Upload photo bytes with Content-Type image/png, image/jpeg, or image/webp.',
        );
      const asset = await assets.upload(id, request.body, mimeType, filename(request));
      try {
        const next = await repository.update(id, expectedVersion, (current) => {
          current.assets.push(asset);
          return invalidateWorkflowContent(current);
        });
        response.status(201).json(envelope(next));
      } catch (error) {
        await assets.remove(id, asset).catch(options.onError ?? (() => undefined));
        throw error;
      }
    },
  );
  router.get('/:id/assets/:assetId', async (request, response) => {
    const workflow = await repository.get(idOf(request));
    const asset = workflow.assets.find((item) => item.id === uuid(request.params.assetId));
    if (!asset)
      throw new ApiError(404, 'ASSET_NOT_FOUND', 'This photo does not belong to the promo.');
    response
      .type(asset.mimeType)
      .set('Content-Disposition', 'inline')
      .send(await assets.load(workflow.id, asset));
  });
  router.patch('/:id/assets/:assetId', async (request, response) => {
    const { expectedVersion, description } = validated(updateAssetDescriptionSchema, request.body);
    response.json(
      envelope(
        await repository.update(idOf(request), expectedVersion, (workflow) => {
          const asset = workflow.assets.find((item) => item.id === uuid(request.params.assetId));
          if (!asset)
            throw new ApiError(404, 'ASSET_NOT_FOUND', 'This photo does not belong to the promo.');
          asset.description = description;
          return invalidateWorkflowContent(workflow);
        }),
      ),
    );
  });
  router.delete('/:id/assets/:assetId', async (request, response) => {
    const previous = await repository.get(idOf(request));
    const asset = previous.assets.find((item) => item.id === uuid(request.params.assetId));
    if (!asset)
      throw new ApiError(404, 'ASSET_NOT_FOUND', 'This photo does not belong to the promo.');
    const next = await repository.update(
      previous.id,
      versionQuery(request),
      (workflow) => {
        workflow.assets = workflow.assets.filter((item) => item.id !== asset.id);
        return invalidateWorkflowContent(workflow);
      },
      { requireIdle: true },
    );
    await assets.remove(previous.id, asset).catch(options.onError ?? (() => undefined));
    response.json(envelope(next));
  });

  router.post('/:id/renders', async (request, response) => {
    const { expectedVersion } = validated(renderRequestSchema, request.body);
    const workflow = await repository.get(idOf(request));
    repository.checkVersion(workflow, expectedVersion);
    response.status(202).json({ job: await renders.enqueue(workflow, expectedVersion) });
  });
  router.get('/:id/renders', async (request, response) => {
    response.json({ jobs: await repository.renders(idOf(request)) });
  });
  router.get('/:id/renders/:jobId', async (request, response) => {
    response.json({ job: await repository.render(idOf(request), uuid(request.params.jobId)) });
  });
  router.get('/:id/renders/:jobId/video', async (request, response, next) => {
    const workflow = await repository.get(idOf(request));
    const job = await repository.render(workflow.id, uuid(request.params.jobId));
    if (job.status !== 'succeeded' || !job.output)
      throw new ApiError(
        409,
        'VIDEO_NOT_READY',
        'This video is not ready to download. Check the render status first.',
      );
    const path = await renders.verifyOutput(job);
    response
      .type('video/mp4')
      .set('X-Yap-Workflow-Version', String(job.workflowVersion))
      .set('X-Yap-Source-Stale', String(workflow.scenes?.id !== job.sourceScenesId));
    if (request.query.download === '1')
      response.attachment(
        `${workflow.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 80) || 'yap-promo'}.mp4`,
      );
    response.sendFile(path, (error) => {
      if (error) next(error);
    });
  });
  router.get('/:id/publish', async (request, response) => {
    const workflow = await repository.get(idOf(request));
    if (Object.values(verifyWorkflow(workflow)).some((report) => report.state !== 'approved'))
      throw new ApiError(
        409,
        'PROMO_APPROVAL_REQUIRED',
        'Approve the current promo before downloading its publish kit.',
      );
    const job = (await repository.renders(workflow.id))
      .filter((item) => item.status === 'succeeded' && item.sourceScenesId === workflow.scenes?.id)
      .at(-1);
    if (!job || !workflow.script)
      throw new ApiError(
        409,
        'PROMO_NOT_RENDERED',
        'Approve and render the current promo before downloading its publish kit.',
      );
    await renders.verifyOutput(job);
    response.json({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      platform: workflow.brief.platform,
      caption: workflow.script.caption,
      script: workflow.script.segments.map((segment) => segment.text).join('\n\n'),
      video: {
        jobId: job.id,
        url: `/api/workflows/${workflow.id}/renders/${job.id}/video?download=1`,
        width: job.width,
        height: job.height,
        duration: job.duration,
        hasAudio: false,
      },
      ready: true,
      automaticPosting: false,
    });
  });
  router.delete('/:id', async (request, response) => {
    const workflow = await repository.get(idOf(request)),
      jobs = await repository.renders(workflow.id);
    await repository.delete(workflow.id, versionQuery(request));
    const results = await Promise.allSettled([
      ...workflow.assets.map((asset) => assets.remove(workflow.id, asset)),
      ...jobs.map((job) => rm(renders.path(job.id), { force: true })),
    ]);
    for (const result of results)
      if (result.status === 'rejected') options.onError?.(result.reason);
    response.status(204).end();
  });
  return { router, close: () => renders.close() };
}
