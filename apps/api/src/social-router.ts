import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  socialDatasetSchema,
  socialHandoffInputSchema,
  socialInvestigationSchema,
  socialNoteInputSchema,
  socialNoteUpdateSchema,
  socialQueryInputSchema,
  socialResearchInputSchema,
  type SocialDataset,
  type SocialInvestigation,
  type SocialResearchInput,
} from '@yap/contracts/social';
import { ApiError } from './errors.js';
import {
  analyzeSocialDataset,
  buildSocialHandoff,
  querySocialAnalysis,
} from './social-analysis.js';
import {
  createSocialProviders,
  socialProviderConfigFromEnv,
  type SocialProviderConfig,
} from './social-providers.js';
import { SocialRepository } from './social-repository.js';

export interface SocialRouterOptions {
  dataFile: string;
  config?: SocialProviderConfig;
  fetch?: typeof globalThis.fetch;
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      'SOCIAL_VALIDATION',
      'Check the research details and try again.',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  return result.data;
}

function uuid(request: Request, key = 'id'): string {
  return validate(z.uuid(), request.params[key]);
}

function assertEvidence(investigation: SocialInvestigation, evidenceIds: string[]) {
  const posts = new Set(investigation.analysis.posts.map((post) => post.id));
  if (evidenceIds.some((id) => !posts.has(id)))
    throw new ApiError(
      400,
      'SOCIAL_EVIDENCE_NOT_FOUND',
      'Attach evidence from this investigation.',
    );
}

function createInvestigation(
  input: SocialResearchInput,
  dataset: SocialDataset,
): SocialInvestigation {
  const now = new Date().toISOString();
  return socialInvestigationSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    analysis: analyzeSocialDataset(input, dataset),
    notes: [],
  });
}

function publicImport(input: SocialResearchInput, dataset: SocialDataset): SocialDataset {
  const posts = new Set<string>();
  const actors = new Set<string>();
  for (const actor of dataset.actors) {
    if (actors.has(actor.id))
      throw new ApiError(400, 'SOCIAL_IMPORT_DUPLICATE', 'Each imported actor needs a unique ID.');
    actors.add(actor.id);
  }
  for (const post of dataset.posts) {
    const url = new URL(post.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const isX =
      ['x.com', 'twitter.com'].includes(host) && /^\/[^/]+\/status\/\d+\/?$/.test(url.pathname);
    const isInstagram =
      host === 'instagram.com' && /^\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    const publicHost =
      host.includes('.') &&
      !isIP(host) &&
      !host.endsWith('.local') &&
      !host.endsWith('.internal') &&
      !host.endsWith('.localhost');
    if (
      !publicHost ||
      (post.platform === 'x' && !isX) ||
      (post.platform === 'instagram' && !isInstagram) ||
      (post.platform === 'web' && ['x.com', 'twitter.com', 'instagram.com'].includes(host))
    )
      throw new ApiError(
        400,
        'SOCIAL_IMPORT_URL',
        'Use public HTTPS post URLs that match each selected platform.',
      );
    if (!input.platforms.includes(post.platform))
      throw new ApiError(
        400,
        'SOCIAL_IMPORT_PLATFORM',
        'Imported posts must belong to the selected platforms.',
      );
    if (posts.has(post.id))
      throw new ApiError(400, 'SOCIAL_IMPORT_DUPLICATE', 'Each imported post needs a unique ID.');
    if (post.actorId && !actors.has(post.actorId))
      throw new ApiError(
        400,
        'SOCIAL_IMPORT_REFERENCE',
        'Every post author must reference an imported actor.',
      );
    posts.add(post.id);
  }
  if (dataset.posts.length > input.limit)
    throw new ApiError(
      400,
      'SOCIAL_IMPORT_LIMIT',
      'The import exceeds this investigation’s post limit.',
    );
  for (const edge of dataset.relationships) {
    if (
      !posts.has(edge.sourcePostId) ||
      (edge.targetPostId && !posts.has(edge.targetPostId)) ||
      (edge.targetActorId && !actors.has(edge.targetActorId))
    )
      throw new ApiError(
        400,
        'SOCIAL_IMPORT_REFERENCE',
        'Imported relationships must reference supplied posts and actors.',
      );
  }
  return socialDatasetSchema.parse({
    ...dataset,
    posts: dataset.posts.map((post) => ({ ...post, provider: 'import' })),
    warnings: [
      ...new Set([
        ...dataset.warnings,
        'Imported public data was supplied by the creator. Access, collection methods, and engagement counts have not been independently verified.',
      ]),
    ].slice(0, 100),
  });
}

export async function createSocialRouter(options: SocialRouterOptions): Promise<Router> {
  const repository = await SocialRepository.open(options.dataFile);
  const providers = createSocialProviders(options.config ?? socialProviderConfigFromEnv(), {
    fetch: options.fetch,
  });
  const router = Router();
  let collecting = 0;

  router.get('/providers', (_request, response) =>
    response.json({ providers: providers.statuses() }),
  );
  router.get('/investigations', async (_request, response) =>
    response.json({ investigations: await repository.list() }),
  );
  router.post('/investigations', async (request, response) => {
    const input = validate(socialResearchInputSchema, request.body);
    if (collecting >= 2)
      throw new ApiError(
        429,
        'SOCIAL_BUSY',
        'Two searches are already running. Wait for one to finish.',
      );
    collecting++;
    const abort = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.on('close', onClose);
    try {
      const dataset = await providers.collect(input, abort.signal);
      if (abort.signal.aborted) return;
      const investigation = await repository.create(createInvestigation(input, dataset));
      response
        .status(201)
        .location(`/api/social/investigations/${investigation.id}`)
        .json({ investigation });
    } finally {
      response.off('close', onClose);
      collecting--;
    }
  });
  router.post('/investigations/import', async (request, response) => {
    const value = validate(
      z
        .object({
          input: socialResearchInputSchema,
          dataset: socialDatasetSchema,
          publicDataOnly: z.literal(true),
        })
        .strict(),
      request.body,
    );
    const input = { ...value.input, mode: 'live' as const };
    const investigation = await repository.create(
      createInvestigation(input, publicImport(input, value.dataset)),
    );
    response
      .status(201)
      .location(`/api/social/investigations/${investigation.id}`)
      .json({ investigation });
  });
  router.get('/investigations/:id', async (request, response) =>
    response.json({ investigation: await repository.get(uuid(request)) }),
  );
  router.delete('/investigations/:id', async (request, response) => {
    await repository.delete(uuid(request));
    response.status(204).end();
  });
  router.post('/investigations/:id/query', async (request, response) => {
    const { question } = validate(socialQueryInputSchema, request.body);
    const investigation = await repository.get(uuid(request));
    response.json(querySocialAnalysis(investigation.analysis, question));
  });
  router.post('/investigations/:id/notes', async (request, response) => {
    const input = validate(socialNoteInputSchema, request.body);
    const investigation = await repository.update(uuid(request), (previous) => {
      if (previous.notes.length >= 100)
        throw new ApiError(
          409,
          'SOCIAL_NOTE_LIMIT',
          'Keep at most 100 notes in one investigation.',
        );
      assertEvidence(previous, input.evidenceIds);
      const now = new Date().toISOString();
      return {
        ...previous,
        updatedAt: now,
        notes: [...previous.notes, { ...input, id: randomUUID(), createdAt: now, updatedAt: now }],
      };
    });
    response.status(201).json({ investigation });
  });
  router.patch('/investigations/:id/notes/:noteId', async (request, response) => {
    const input = validate(socialNoteUpdateSchema, request.body);
    const noteId = uuid(request, 'noteId');
    const investigation = await repository.update(uuid(request), (previous) => {
      if (!previous.notes.some((note) => note.id === noteId))
        throw new ApiError(404, 'SOCIAL_NOTE_NOT_FOUND', 'This note could not be found.');
      if (input.evidenceIds) assertEvidence(previous, input.evidenceIds);
      const now = new Date().toISOString();
      return {
        ...previous,
        updatedAt: now,
        notes: previous.notes.map((note) =>
          note.id === noteId ? { ...note, ...input, updatedAt: now } : note,
        ),
      };
    });
    response.json({ investigation });
  });
  router.delete('/investigations/:id/notes/:noteId', async (request, response) => {
    const noteId = uuid(request, 'noteId');
    const investigation = await repository.update(uuid(request), (previous) => {
      if (!previous.notes.some((note) => note.id === noteId))
        throw new ApiError(404, 'SOCIAL_NOTE_NOT_FOUND', 'This note could not be found.');
      return {
        ...previous,
        updatedAt: new Date().toISOString(),
        notes: previous.notes.filter((note) => note.id !== noteId),
      };
    });
    response.json({ investigation });
  });
  router.post('/investigations/:id/handoff', async (request, response) => {
    const input = validate(socialHandoffInputSchema, request.body);
    const investigation = await repository.get(uuid(request));
    if (!input.noteIds.length && !input.insightIds.length)
      throw new ApiError(
        400,
        'SOCIAL_SELECTION_REQUIRED',
        'Select at least one note or insight for the script brief.',
      );
    if (
      input.noteIds.some((id) => !investigation.notes.some((note) => note.id === id)) ||
      input.insightIds.some(
        (id) => !investigation.analysis.insights.some((insight) => insight.id === id),
      )
    )
      throw new ApiError(
        400,
        'SOCIAL_SELECTION_NOT_FOUND',
        'Select notes and insights from this investigation.',
      );
    response.json(buildSocialHandoff(investigation, input));
  });
  return router;
}
