import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
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

export interface AppOptions {
  dataFile?: string;
  corsOrigin?: string;
  onError?: (error: unknown) => void;
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
  const repository = await ProjectRepository.open(
    options.dataFile ?? resolve(process.cwd(), 'data/projects.json'),
  );
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
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '128kb' }));

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
      const briefChanged = briefKeys.some(
        (key) => changes[key] !== undefined && changes[key] !== previous[key],
      );
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
      response.status(413).json({
        error: {
          code: 'BODY_TOO_LARGE',
          message: 'The request is too large. Keep it under 128 KB.',
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
