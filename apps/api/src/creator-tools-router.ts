import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { creatorImageInputSchema, type CreatorImageQuote } from '@yap/contracts/reference-assets';
import { ApiError } from './errors.js';
import { createBrandService } from './creator-brand.js';
import { createEditService } from './creator-edit.js';
import { createCreatorImageAdapter, createCreatorImageService } from './creator-images.js';
import { createReferenceAnalysisService } from './creator-reference-analysis.js';
import type { ReferenceAnalyze } from '@yap/contracts/reference-assets';
import { createReferenceSceneAnalyzer } from './creator-reference-vision.js';
import type { CreatorRepository } from './creator-repository.js';
import type { WorkflowRepository } from './workflow-repository.js';
import type { CreatorJobs } from './creator-jobs.js';
import type { ApprovedImageQuote } from './creator-paid-requests.js';

export type PaidImageRunner = <T>(
  quote: ApprovedImageQuote,
  requestId: string,
  operation: () => Promise<T>,
  beforeSubmit?: () => Promise<void>,
) => Promise<T>;
export type PaidReferenceRunner = <T>(
  approval: ReferenceAnalyze,
  operation: () => Promise<T>,
  beforeSubmit: () => Promise<void>,
) => Promise<T>;
export interface CreatorToolsOptions {
  directory: string;
  repository: CreatorRepository;
  workflows: WorkflowRepository;
  fetch: typeof fetch;
  paidImage?: PaidImageRunner;
  paidReference?: PaidReferenceRunner;
  apiKey?: string;
  model?: string;
}
const uuid = (request: Request, name = 'id') => z.uuid().parse(request.params[name]);
const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

export async function createCreatorTools(options: CreatorToolsOptions) {
  const brands = await createBrandService(options.directory),
    edits = await createEditService(options.directory);
  const controllers = new Set<AbortController>(),
    pending = new Set<Promise<unknown>>();
  let closed = false;
  async function run<T>(
    request: Request,
    response: Response,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new ApiError(503, 'CREATOR_CLOSED', 'Creation is shutting down.');
    if (controllers.size >= 3)
      throw new ApiError(
        429,
        'CREATOR_TOOLS_BUSY',
        'Wait for another local media operation to finish.',
      );
    const controller = new AbortController(),
      abort = () => {
        if (!response.writableEnded) controller.abort();
      };
    request.once('aborted', abort);
    response.once('close', abort);
    controllers.add(controller);
    const operationPromise = operation(controller.signal);
    pending.add(operationPromise);
    try {
      return await operationPromise;
    } finally {
      pending.delete(operationPromise);
      controllers.delete(controller);
      request.off('aborted', abort);
      response.off('close', abort);
    }
  }
  async function context(sessionId: string) {
    const session = await options.repository.get(sessionId),
      workflow = await options.workflows.get(session.workflowId);
    return { sessionId, sessionVersion: session.version, workflowVersion: workflow.version };
  }
  async function currentImage(quote: CreatorImageQuote) {
    const value = await context(quote.sessionId);
    if (
      quote.sessionVersion !== value.sessionVersion ||
      quote.workflowVersion !== value.workflowVersion
    )
      throw new ApiError(
        409,
        'CREATOR_IMAGE_QUOTE_STALE',
        'The creation changed. Review a new image quote.',
      );
  }
  const images = createCreatorImageService(join(options.directory, 'assets'), {
    adapter: createCreatorImageAdapter({ apiKey: options.apiKey }, options.fetch),
    ...(options.paidImage
      ? {
          paid: <T>(quote: CreatorImageQuote, requestId: string, operation: () => Promise<T>) =>
            options.paidImage!(quote, requestId, operation, () => currentImage(quote)),
        }
      : {}),
  });
  const rawAnalysis = createReferenceSceneAnalyzer(
    { apiKey: options.apiKey, model: options.model },
    options.fetch,
  );
  const references: ReturnType<typeof createReferenceAnalysisService> =
    createReferenceAnalysisService(
      join(options.directory, 'assets'),
      rawAnalysis && options.paidReference
        ? {
            analyzeFrames: async (input, approval, signal) => {
              const check = async () => {
                const current = await references.get(input.sessionId, input.referenceId);
                if (
                  current.sourceHash !== input.sourceHash ||
                  !current.requests.some(
                    (request) =>
                      request.requestId === approval.requestId && request.status === 'running',
                  )
                )
                  throw new ApiError(
                    409,
                    'REFERENCE_ANALYSIS_STALE',
                    'The reference changed. Review its current samples.',
                  );
              };
              await check();
              return options.paidReference!(
                approval,
                () => rawAnalysis(input, approval, signal),
                check,
              );
            },
          }
        : {},
    );
  async function baseFilm(jobs: CreatorJobs, sessionId: string, jobId: string) {
    const session = await options.repository.get(sessionId),
      workflow = await options.workflows.get(session.workflowId),
      job = await options.repository.job(sessionId, jobId);
    if (
      job.kind !== 'production' ||
      job.approvalId !== session.approval?.id ||
      job.workflowVersion !== workflow.version ||
      job.planId !== session.plan?.id
    )
      throw new ApiError(
        409,
        'CREATOR_EDIT_BASE_STALE',
        'Use the current approved finished film as the edit source.',
      );
    const path = await jobs.verifyOutput(job),
      output = job.output!;
    let at = 0;
    const clips = session.plan!.clips.map((clip) => {
      const start = at;
      at += clip.seconds;
      return { id: clip.id, start, end: at };
    });
    return {
      path,
      base: {
        jobId,
        sha256: output.sha256,
        bytes: output.bytes,
        duration: output.duration,
        width: output.width,
        height: output.height,
        hasAudio: output.hasAudio,
        clips,
      },
    };
  }
  function router(jobs: CreatorJobs) {
    const router = express.Router();
    const brandResponse = async () => ({
      brand: await brands.get(),
      snapshot: await brands.snapshot(),
    });
    router.get('/brand', async (_request, response) => response.json(await brandResponse()));
    router.patch('/brand', async (request, response) => {
      await brands.update(request.body);
      response.json(await brandResponse());
    });
    router.put(
      '/brand/logo',
      express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '8mb' }),
      async (request, response) => {
        await brands.uploadLogo({
          expectedVersion: z.coerce
            .number()
            .int()
            .nonnegative()
            .parse(request.query.expectedVersion),
          bytes: request.body,
        });
        response.json(await brandResponse());
      },
    );
    router.delete('/brand/logo', async (request, response) => {
      await brands.clearLogo(
        z.object({ expectedVersion: z.number().int().nonnegative() }).strict().parse(request.body),
      );
      response.json(await brandResponse());
    });
    router.get('/brand/logo/:sha256.png', async (request, response) => {
      const hash = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(request.params.sha256),
        brand = await brands.snapshot();
      if (!brand.logo || brand.logo.sha256 !== hash)
        throw new ApiError(
          404,
          'CREATOR_BRAND_LOGO_MISSING',
          'This workspace logo is not current.',
        );
      response
        .set(privateHeaders)
        .type('png')
        .send(await readFile(brands.logoPath(brand.logo)));
    });
    router.get('/sessions/:id/edits', async (request, response) => {
      const id = uuid(request);
      await context(id);
      response.json({ edits: await edits.list(id) });
    });
    router.post('/sessions/:id/edits', async (request, response) => {
      const id = uuid(request),
        { jobId } = z.object({ jobId: z.uuid() }).strict().parse(request.body);
      const source = await baseFilm(jobs, id, jobId);
      response.status(201).json({ edit: await edits.create(id, source.base) });
    });
    router.get('/sessions/:id/edits/:editId', async (request, response) => {
      const id = uuid(request);
      await context(id);
      response.json({ edit: await edits.get(id, uuid(request, 'editId')) });
    });
    router.patch('/sessions/:id/edits/:editId', async (request, response) => {
      const id = uuid(request),
        editId = uuid(request, 'editId'),
        edit = await edits.get(id, editId);
      await baseFilm(jobs, id, edit.base.jobId);
      if (request.body?.draft?.brand) await brands.verifySnapshot(request.body.draft.brand);
      response.json({ edit: await edits.update(id, editId, request.body) });
    });
    router.get('/sessions/:id/edits/:editId/history', async (request, response) => {
      const id = uuid(request);
      await context(id);
      response.json({ history: await edits.history(id, uuid(request, 'editId')) });
    });
    router.post('/sessions/:id/edits/:editId/render', async (request, response) => {
      const id = uuid(request),
        editId = uuid(request, 'editId'),
        edit = await edits.get(id, editId),
        source = await baseFilm(jobs, id, edit.base.jobId);
      const render = await run(request, response, (signal) =>
        edits.render(id, editId, request.body, source.path, signal),
      );
      response.json({ render });
    });
    router.get(
      '/sessions/:id/edits/:editId/renders/:renderId/video',
      async (request, response, next) => {
        const id = uuid(request),
          editId = uuid(request, 'editId'),
          edit = await edits.get(id, editId);
        await baseFilm(jobs, id, edit.base.jobId);
        const { path } = await edits.verifyOutput(id, editId, uuid(request, 'renderId'));
        response.set(privateHeaders).type('mp4');
        if (request.query.download === '1') response.attachment('yap-edited-film.mp4');
        response.sendFile(path, { cacheControl: false }, (error) => {
          if (error) next(error);
        });
      },
    );
    router.get('/sessions/:id/images', async (request, response) => {
      const id = uuid(request);
      await context(id);
      response.json({
        images: await images.list(id),
        configured: images.configured,
        model: images.model,
      });
    });
    router.post('/sessions/:id/images/quote', async (request, response) => {
      const value = await context(uuid(request));
      const { sessionVersion, workflowVersion, ...input } = request.body ?? {};
      if (
        (sessionVersion !== undefined && sessionVersion !== value.sessionVersion) ||
        (workflowVersion !== undefined && workflowVersion !== value.workflowVersion)
      )
        throw new ApiError(
          409,
          'CREATOR_IMAGE_QUOTE_STALE',
          'Reload the creation before reviewing an image quote.',
        );
      response.json({ quote: await images.quote(value, creatorImageInputSchema.parse(input)) });
    });
    router.post('/sessions/:id/images/generate', async (request, response) => {
      const value = await context(uuid(request)),
        image = await run(request, response, (signal) =>
          images.generate(value, request.body, signal, async () => {
            const current = await context(value.sessionId);
            if (JSON.stringify(current) !== JSON.stringify(value))
              throw new ApiError(
                409,
                'CREATOR_IMAGE_QUOTE_STALE',
                'The creation changed before image generation.',
              );
          }),
        );
      response.json({ image });
    });
    router.get('/sessions/:id/images/:frameId/image', async (request, response) => {
      const id = uuid(request);
      await context(id);
      const { bytes } = await images.verifyImage(id, uuid(request, 'frameId'));
      response.set(privateHeaders).type('png').send(bytes);
    });
    router.get('/sessions/:id/reference-analysis', async (request, response) => {
      const id = uuid(request);
      await context(id);
      response.json({ references: await references.list(id), configured: references.configured });
    });
    router.post('/sessions/:id/reference-analysis', async (request, response) => {
      const id = uuid(request);
      await context(id);
      response.status(201).json({ reference: await references.import(id, request.body) });
    });
    router.get('/sessions/:id/reference-analysis/:referenceId', async (request, response) => {
      const id = uuid(request);
      await context(id);
      response.json({ reference: await references.get(id, uuid(request, 'referenceId')) });
    });
    router.post(
      '/sessions/:id/reference-analysis/:referenceId/frames',
      express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }),
      async (request, response) => {
        const id = uuid(request);
        await context(id);
        response.json({
          reference: await references.addFrame(id, uuid(request, 'referenceId'), {
            expectedVersion: z.coerce
              .number()
              .int()
              .positive()
              .parse(request.query.expectedVersion),
            atSeconds: z.coerce.number().min(0).max(7200).parse(request.query.atSeconds),
            bytes: request.body,
          }),
        });
      },
    );
    router.post(
      '/sessions/:id/reference-analysis/:referenceId/observations',
      async (request, response) => {
        const id = uuid(request);
        await context(id);
        response.json({
          reference: await references.addObservation(
            id,
            uuid(request, 'referenceId'),
            request.body,
          ),
        });
      },
    );
    router.post(
      '/sessions/:id/reference-analysis/:referenceId/analyze',
      async (request, response) => {
        const id = uuid(request);
        await context(id);
        const reference = await run(request, response, (signal) =>
          references.analyze(id, uuid(request, 'referenceId'), request.body, signal),
        );
        response.json({ reference });
      },
    );
    router.get(
      '/sessions/:id/reference-analysis/:referenceId/frames/:frameId/image',
      async (request, response) => {
        const id = uuid(request);
        await context(id);
        const { bytes } = await references.verifyFrame(
          id,
          uuid(request, 'referenceId'),
          uuid(request, 'frameId'),
        );
        response.set(privateHeaders).type('jpeg').send(bytes);
      },
    );
    router.use((error: unknown, _request: Request, _response: Response, next: NextFunction) => {
      if (error instanceof z.ZodError)
        next(
          new ApiError(
            400,
            'CREATOR_TOOLS_VALIDATION',
            'Check the media details.',
            error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          ),
        );
      else next(error);
    });
    return router;
  }
  return {
    brands,
    edits,
    images,
    references,
    router,
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
