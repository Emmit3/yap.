import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import express, { type ErrorRequestHandler, type Request } from 'express';
import cors from 'cors';
import { z } from 'zod';
import {
  createProjectSchema,
  updateProjectSchema,
  type Project,
  type ProjectBrief,
} from '@yap/contracts';
import { ApiError, StorageError } from './errors.js';
import { ProjectRepository } from './repository.js';
import { generateGuidedDraft } from './generation.js';
import { exportFilename, exportMarkdown } from './export.js';
import { createSocialRouter } from './social-router.js';
import type { SocialProviderConfig } from './social-providers.js';
import { createWorkflowRouter } from './workflow-router.js';
import type { VideoWorkflowProvider, WorkflowProviderConfig } from './workflow-provider.js';
import type { PromoRenderer } from './video-render-queue.js';
import { createCreatorRouter, type CreatorRouterOptions } from './creator-router.js';
import { createCreatorPaidRequests, BUDGET_OPENAI_MODEL } from './creator-paid-requests.js';
import { createCreatorResearch, creatorResearchConfigFromEnv } from './creator-research.js';
import { createCreatorVisionAuditor } from './creator-media.js';
import { createCreatorVoiceover } from './creator-audio.js';
import { createPosterRouter } from './poster-router.js';

export interface AppOptions {
  dataFile?: string;
  corsOrigin?: string;
  workflowDataFile?: string;
  assetsDirectory?: string;
  rendersDirectory?: string;
  workflowProviderConfig?: WorkflowProviderConfig;
  workflowProvider?: VideoWorkflowProvider;
  workflowFetch?: typeof globalThis.fetch;
  promoRenderer?: PromoRenderer;
  onError?: (error: unknown) => void;
  socialDataFile?: string;
  socialProviderConfig?: SocialProviderConfig;
  socialFetch?: typeof globalThis.fetch;
  creatorDataFile?: string;
  creatorDirectory?: string;
  posterReferencesDirectory?: string;
  posterDesignDataFile?: string;
  creatorOptions?: Partial<
    Pick<
      CreatorRouterOptions,
      | 'videoConfig'
      | 'video'
      | 'videoProviders'
      | 'auditor'
      | 'voiceover'
      | 'music'
      | 'analyze'
      | 'fetch'
      | 'withBudget'
      | 'budgetLimitCents'
    >
  >;
}

const briefKeys: Array<keyof ProjectBrief> = [
  'title',
  'idea',
  'audience',
  'platform',
  'duration',
  'tone',
  'goal',
];

function projectId(request: Request): string {
  const id = z.uuid().safeParse(request.params.id);
  if (!id.success) throw new ApiError(400, 'INVALID_PROJECT_ID', 'Use a valid project ID.');
  return id.data;
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Check the project details and try again.',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export async function createApp(options: AppOptions = {}) {
  const workflowSpending = createCreatorPaidRequests(options.workflowFetch);
  const socialSpending = createCreatorPaidRequests(options.socialFetch);
  const creatorSpending = createCreatorPaidRequests(options.creatorOptions?.fetch);
  const projectDataFile = options.dataFile ?? resolve(process.cwd(), 'data/projects.json');
  const repository = await ProjectRepository.open(projectDataFile);
  const workflow = await createWorkflowRouter({
    dataFile: options.workflowDataFile ?? join(dirname(projectDataFile), 'workflows.json'),
    assetsDirectory: options.assetsDirectory ?? join(dirname(projectDataFile), 'photos'),
    rendersDirectory: options.rendersDirectory ?? join(dirname(projectDataFile), 'videos'),
    providerConfig: options.workflowProviderConfig,
    provider: options.workflowProvider,
    fetch: workflowSpending.fetch,
    renderer: options.promoRenderer,
    onError: options.onError,
  });
  const allowedOrigin = options.corsOrigin ?? 'http://127.0.0.1:5173';
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(
    cors({
      origin(origin, done) {
        if (!origin || origin === allowedOrigin) return done(null, true);
        done(
          new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed to access the API.'),
        );
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposedHeaders: ['Content-Disposition', 'X-Yap-Workflow-Version', 'X-Yap-Source-Stale'],
    }),
  );
  app.use(express.json({ limit: '128kb' }));
  app.use('/api/workflows', workflow.router);
  app.use(
    '/api/posters',
    createPosterRouter({
      rootDirectory: options.posterReferencesDirectory,
      dataFile:
        options.posterDesignDataFile ?? join(dirname(projectDataFile), 'poster-designs.json'),
    }),
  );
  app.locals.shutdown = workflow.close;

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', service: 'yap-api', generator: 'guided' });
  });
  app.get('/api/projects', async (_request, response) => {
    response.json({ projects: await repository.list() });
  });
  app.post('/api/projects', async (request, response) => {
    const brief = validate(createProjectSchema, request.body);
    const now = new Date().toISOString();
    const project: Project = {
      ...brief,
      id: randomUUID(),
      status: 'draft',
      draft: null,
      createdAt: now,
      updatedAt: now,
    };
    response
      .status(201)
      .location(`/api/projects/${project.id}`)
      .json({ project: await repository.create(project) });
  });
  app.get('/api/projects/:id', async (request, response) => {
    response.json({ project: await repository.get(projectId(request)) });
  });
  app.patch('/api/projects/:id', async (request, response) => {
    const id = projectId(request);
    const changes = validate(updateProjectSchema, request.body);
    const project = await repository.update(id, (previous) => {
      const researchChanged =
        changes.research !== undefined &&
        JSON.stringify(changes.research) !== JSON.stringify(previous.research);
      const briefChanged =
        researchChanged ||
        briefKeys.some((key) => changes[key] !== undefined && changes[key] !== previous[key]);
      if (briefChanged && changes.draft) {
        throw new ApiError(
          409,
          'BRIEF_AND_DRAFT_CONFLICT',
          'Save changes to the brief before editing the script.',
        );
      }
      const { draft, ...fields } = changes;
      const next: Project = { ...previous, ...fields, updatedAt: new Date().toISOString() };
      if (briefChanged) {
        next.draft = null;
        next.status = 'draft';
      }
      if (draft) {
        if (!previous.draft)
          throw new ApiError(
            409,
            'DRAFT_REQUIRED',
            'Create a guided draft before editing the script.',
          );
        const total = draft.shots.reduce((sum, shot) => sum + shot.seconds, 0);
        if (total !== next.duration)
          throw new ApiError(
            400,
            'INVALID_SHOT_DURATION',
            `Shot durations must add up to ${next.duration} seconds.`,
          );
        if (new Set(draft.shots.map((shot) => shot.id)).size !== draft.shots.length)
          throw new ApiError(400, 'DUPLICATE_SHOT_ID', 'Each shot must have a unique ID.');
        next.draft = {
          ...draft,
          provider: previous.draft.provider,
          generatedAt: previous.draft.generatedAt,
        };
      }
      if (changes.status === 'ready' && !next.draft)
        throw new ApiError(
          409,
          'DRAFT_REQUIRED',
          'Create a script and shot plan before marking this project ready.',
        );
      return next;
    });
    response.json({ project });
  });
  app.post('/api/projects/:id/generate', async (request, response) => {
    if (
      request.body !== undefined &&
      (typeof request.body !== 'object' ||
        request.body === null ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length > 0)
    ) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'The draft uses the saved brief. Do not send additional fields.',
      );
    }
    const project = await repository.update(projectId(request), (previous) => ({
      ...previous,
      draft: generateGuidedDraft(previous),
      status: 'draft',
      updatedAt: new Date().toISOString(),
    }));
    response.json({ project });
  });
  app.get('/api/projects/:id/export', async (request, response) => {
    const format = request.query.format ?? 'markdown';
    if (format !== 'markdown' && format !== 'json')
      throw new ApiError(
        400,
        'INVALID_EXPORT_FORMAT',
        'Choose markdown or json for the export format.',
      );
    const project = await repository.get(projectId(request));
    response.attachment(exportFilename(project, format === 'json' ? 'json' : 'md'));
    if (format === 'json')
      response.type('application/json').send(JSON.stringify({ project }, null, 2));
    else response.type('text/markdown').send(exportMarkdown(project));
  });
  app.delete('/api/projects/:id', async (request, response) => {
    await repository.delete(projectId(request));
    response.status(204).end();
  });
  let social: Awaited<ReturnType<typeof createSocialRouter>>;
  try {
    social = await createSocialRouter({
      dataFile:
        options.socialDataFile ?? resolve(dirname(projectDataFile), 'social-investigations.json'),
      config: options.socialProviderConfig,
      fetch: socialSpending.fetch,
    });
  } catch (error) {
    await workflow.close();
    throw error;
  }
  app.use('/api/social', social);
  let creator: Awaited<ReturnType<typeof createCreatorRouter>>;
  try {
    const researchConfig = creatorResearchConfigFromEnv();
    const research =
      options.creatorOptions?.analyze ??
      createCreatorResearch(researchConfig, {
        fetch: creatorSpending.fetch,
      });
    const liveResearch = Boolean(
      researchConfig.firecrawlApiKey ||
      (researchConfig.deepAgentsApiKey && researchConfig.deepAgentsModel),
    );
    const rawAuditor =
      options.creatorOptions?.auditor ??
      createCreatorVisionAuditor(
        {
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.OPENAI_MODEL || BUDGET_OPENAI_MODEL,
        },
        creatorSpending.fetch,
      );
    const rawVoiceover =
      options.creatorOptions?.voiceover ??
      createCreatorVoiceover({ apiKey: process.env.OPENAI_API_KEY }, creatorSpending.fetch);
    const supportedAudit =
      Boolean(options.creatorOptions?.auditor) ||
      !process.env.OPENAI_MODEL?.trim() ||
      process.env.OPENAI_MODEL.trim() === BUDGET_OPENAI_MODEL;
    const suppliedBudget = process.env.CREATOR_BUDGET_LIMIT_USD?.trim();
    const budgetLimitCents =
      options.creatorOptions?.budgetLimitCents ??
      (suppliedBudget ? Math.round(Number(suppliedBudget) * 100) : 3000);
    if (
      !Number.isInteger(budgetLimitCents) ||
      budgetLimitCents < 1 ||
      budgetLimitCents > 3000 ||
      (suppliedBudget && !/^\d+(?:\.\d{1,2})?$/.test(suppliedBudget))
    )
      throw new ApiError(
        503,
        'CREATOR_BUDGET_CONFIGURATION',
        'Set CREATOR_BUDGET_LIMIT_USD between 0.01 and 30.00.',
      );
    creator = await createCreatorRouter({
      dataFile: options.creatorDataFile ?? join(dirname(projectDataFile), 'creator-sessions.json'),
      directory: options.creatorDirectory ?? join(dirname(projectDataFile), 'creator-videos'),
      workflows: workflow.repository,
      assets: workflow.assets,
      provider: workflow.provider,
      onError: options.onError,
      ...options.creatorOptions,
      budgetLimitCents,
      fetch: creatorSpending.fetch,
      paidImage: creatorSpending.approvedImage,
      paidReference: creatorSpending.approvedReference,
      auditor: {
        configured: rawAuditor.configured && supportedAudit,
        audit: (...args) => creatorSpending.prepaid(() => rawAuditor.audit(...args), args[4]),
      },
      voiceover: {
        configured: rawVoiceover.configured,
        // The production job's approved audio hold covers exactly one request per line.
        // The gate runs the pre-submit check as the last step before each request leaves, so
        // the built-in adapter must not run it earlier. A supplied adapter does not send
        // through the gate and has to run the check itself.
        narrate: (lines, voice, tone, signal, beforeSubmit) =>
          creatorSpending.prepaid(
            () =>
              rawVoiceover.narrate(
                lines,
                voice,
                tone,
                signal,
                options.creatorOptions?.voiceover ? beforeSubmit : undefined,
              ),
            beforeSubmit,
            lines.length,
          ),
      },
      withBudget(ledger) {
        workflowSpending.attach(ledger);
        socialSpending.attach(ledger);
        creatorSpending.attach(ledger);
        const custom = options.creatorOptions?.withBudget?.(ledger);
        const analyzed = creatorSpending.research(async (...args) => {
          if (
            researchConfig.deepAgentsModel &&
            researchConfig.deepAgentsApiKey &&
            researchConfig.deepAgentsModel !== BUDGET_OPENAI_MODEL
          )
            throw new ApiError(
              503,
              'CREATOR_BUDGET_MODEL',
              'Use gpt-6-luna for Deep Agents in the budget profile.',
            );
          return research(...args);
        }, liveResearch);
        return {
          provider: custom?.provider ?? workflow.provider,
          analyze: custom?.analyze ?? analyzed,
        };
      },
    });
  } catch (error) {
    await Promise.all([workflow.close(), social.closeSocialRuns()]);
    throw error;
  }
  app.use('/api/creator', creator.router);
  app.locals.shutdown = async () => {
    await Promise.all([workflow.close(), social.closeSocialRuns(), creator.close()]);
  };
  app.use((_request, _response, next) =>
    next(new ApiError(404, 'NOT_FOUND', 'This API route could not be found.')),
  );

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    } else if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      response
        .status(400)
        .json({ error: { code: 'INVALID_JSON', message: 'Send valid JSON in the request body.' } });
    } else if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      const imageUpload = _request.path.includes('/assets');
      response.status(413).json({
        error: {
          code: imageUpload ? 'IMAGE_TOO_LARGE' : 'BODY_TOO_LARGE',
          message: imageUpload
            ? 'The photo is too large. Keep each photo under 10 MB.'
            : 'The request is too large. Keep it under 128 KB.',
        },
      });
    } else {
      options.onError?.(error);
      response.status(500).json({
        error: {
          code: error instanceof StorageError ? 'STORAGE_ERROR' : 'INTERNAL_ERROR',
          message:
            error instanceof StorageError
              ? error.message
              : 'The request could not be completed. Try again.',
        },
      });
    }
  };
  app.use(errorHandler);
  return app;
}
