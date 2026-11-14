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
  socialResearchRunInputSchema,
  socialResearchArtifactPathSchema,
  type SocialDataset,
  type SocialInvestigation,
  type SocialResearchInput,
  type SocialAnalysis,
  type SocialResearchCapabilities,
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
import {
  SocialResearchRuns,
  type SocialDeepAgentsRunner,
  type SocialResearchRunContext,
} from './social-runs.js';
import { socialDeepAgentsAvailable } from './social-agent-config.js';

export interface SocialRouterOptions {
  dataFile: string;
  config?: SocialProviderConfig;
  fetch?: typeof globalThis.fetch;
  researchRunTimeoutMs?: number;
  demoStepDelayMs?: number;
  deepAgentsRunner?: SocialDeepAgentsRunner;
  deepAgentsAvailable?: () => { configured: boolean; reason: string };
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
  analysis?: SocialAnalysis,
): SocialInvestigation {
  const now = new Date().toISOString();
  return socialInvestigationSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    analysis: analysis ?? analyzeSocialDataset(input, dataset),
    notes: [],
  });
}

function publicImport(input: SocialResearchInput, dataset: SocialDataset): SocialDataset {
  const posts = new Set<string>();
  const actors = new Set<string>();
  const actorPlatforms = new Map(dataset.actors.map((actor) => [actor.id, actor.platform]));
  for (const actor of dataset.actors) {
    if (actors.has(actor.id))
      throw new ApiError(400, 'SOCIAL_IMPORT_DUPLICATE', 'Each imported actor needs a unique ID.');
    actors.add(actor.id);
    if (actor.url) {
      const url = new URL(actor.url);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      const isX =
        ['x.com', 'twitter.com'].includes(host) && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(url.pathname);
      const isInstagram =
        host === 'instagram.com' && /^\/[A-Za-z0-9_.]{1,30}\/?$/.test(url.pathname);
      const publicHost =
        host.includes('.') &&
        !isIP(host) &&
        !host.endsWith('.local') &&
        !host.endsWith('.internal') &&
        !host.endsWith('.localhost');
      if (
        !publicHost ||
        (actor.platform === 'x' && !isX) ||
        (actor.platform === 'instagram' && !isInstagram) ||
        (actor.platform === 'web' && ['x.com', 'twitter.com', 'instagram.com'].includes(host))
      )
        throw new ApiError(
          400,
          'SOCIAL_IMPORT_ACTOR_URL',
          'Imported actor URLs must be public profiles matching the actor platform.',
        );
    }
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
    if (post.actorId && actorPlatforms.get(post.actorId) !== post.platform)
      throw new ApiError(
        400,
        'SOCIAL_IMPORT_ACTOR_PLATFORM',
        'Imported post authors must belong to the same platform as their posts.',
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

export async function createSocialRouter(
  options: SocialRouterOptions,
): Promise<Router & { closeSocialRuns: () => Promise<void> }> {
  const repository = await SocialRepository.open(options.dataFile);
  const providers = createSocialProviders(options.config ?? socialProviderConfigFromEnv(), {
    fetch: options.fetch,
  });
  const router = Router();
  const runs = new SocialResearchRuns({ timeoutMs: options.researchRunTimeoutMs });
  const demoDelay = options.demoStepDelayMs ?? 750;
  if (!Number.isInteger(demoDelay) || demoDelay < 0 || demoDelay > 2000)
    throw new ApiError(
      503,
      'SOCIAL_RUN_CONFIGURATION',
      'Set the demo step delay between 0 and 2000 milliseconds.',
    );
  const deepAgents: SocialDeepAgentsRunner =
    options.deepAgentsRunner ??
    (async (context) => {
      const { runSocialDeepAgents } = await import('./social-deepagents.js');
      return runSocialDeepAgents(context);
    });
  const deepAvailability = options.deepAgentsAvailable ?? socialDeepAgentsAvailable;
  const legacyCollections = new Map<AbortController, Promise<void>>();
  let closing = false;
  const ensureResearchOpen = () => {
    if (closing)
      throw new ApiError(
        503,
        'SOCIAL_RUN_CLOSED',
        'Research is shutting down. Start a new search after the API restarts.',
      );
  };

  router.get('/research-runs/capabilities', (_request, response) => {
    const deep = deepAvailability();
    const capabilities: SocialResearchCapabilities = {
      defaultHarness: 'pipeline',
      demoReplay: true,
      pollIntervalMs: 750,
      harnesses: [
        {
          id: 'pipeline',
          name: 'Research pipeline',
          configured: providers.statuses().some((provider) => provider.configured),
          description:
            'Bounded public collection, evidence validation, network analysis, and creative insights.',
          limitations: [
            'Live research needs a configured public-data provider.',
            'The illustrative replay works without credentials.',
          ],
        },
        {
          id: 'deepagents',
          name: 'LangChain Deep Agents',
          configured: deep.configured,
          description: deep.reason,
          limitations: [
            'Live agent execution needs configured model and public-data credentials.',
            'Activity reports tasks and tools; private reasoning is not shown.',
          ],
        },
      ],
    };
    response.json(capabilities);
  });
  router.post('/research-runs', (request, response) => {
    ensureResearchOpen();
    const input = validate(socialResearchRunInputSchema, request.body);
    if (legacyCollections.size + runs.activeCount >= 2)
      throw new ApiError(
        429,
        'SOCIAL_BUSY',
        'Two searches are already running. Wait for one to finish.',
      );
    if (input.mode === 'live' && input.harness === 'deepagents' && !deepAvailability().configured)
      throw new ApiError(503, 'SOCIAL_DEEPAGENTS_NOT_CONFIGURED', deepAvailability().reason);
    if (
      input.mode === 'live' &&
      !providers
        .statuses()
        .some(
          (provider) =>
            provider.configured &&
            provider.platforms.some((platform) => input.platforms.includes(platform)),
        )
    )
      throw new ApiError(
        503,
        'SOCIAL_NOT_CONFIGURED',
        'Connect a compatible public-data provider, or choose the illustrative replay.',
      );
    const execution = input.mode === 'demo' ? 'demo_replay' : input.harness;
    const run = runs.start(input, execution, async (context) => {
      const createdArtifacts = new Set<Parameters<typeof context.writeArtifact>[0]>();
      const writeArtifact: typeof context.writeArtifact = (path, content) => {
        context.writeArtifact(path, content);
        createdArtifacts.add(path);
      };
      const writeMissing: typeof context.writeArtifact = (path, content) => {
        if (!createdArtifacts.has(path)) writeArtifact(path, content);
      };
      const { harness: _harness, ...scope } = context.input;
      const pause = () =>
        input.mode === 'demo' ? stepDelay(demoDelay, context.signal) : Promise.resolve();
      context.emit({
        agent: 'coordinator',
        task: 'scope',
        phase: 'started',
        message:
          input.mode === 'demo'
            ? 'Replaying a synthetic research workflow. These are illustrative steps, not live agent research.'
            : 'Preparing the selected public-data research scope.',
      });
      writeArtifact(
        '/research/scope.json',
        JSON.stringify(
          {
            topic: scope.topic,
            audience: scope.audience,
            platforms: scope.platforms,
            days: scope.days,
            limit: scope.limit,
            mode: scope.mode,
            harness: input.harness,
            execution,
          },
          null,
          2,
        ),
      );
      context.emit({
        agent: 'coordinator',
        task: 'scope',
        phase: 'completed',
        message: 'Research scope prepared with explicit source and result limits.',
      });
      await pause();
      const collect = async (research: SocialResearchInput, signal: AbortSignal) => {
        const traced = createSocialProviders(options.config ?? socialProviderConfigFromEnv(), {
          fetch: tracedFetch(context, options.fetch ?? globalThis.fetch),
        });
        return traced.collect(research, signal);
      };
      context.emit({
        agent: 'source_researcher',
        task: 'collect',
        phase: 'started',
        message:
          scope.mode === 'demo'
            ? 'Loading clearly labeled synthetic source records.'
            : 'Searching configured public sources.',
        search: scope.topic,
      });
      const dataset = socialDatasetSchema.parse(
        scope.mode === 'live' && input.harness === 'deepagents'
          ? await deepAgents({ ...context, writeArtifact, collect })
          : await collect(scope, context.signal),
      );
      ensureActive(context.signal);
      writeMissing('/research/sources.json', sourcesArtifact(dataset));
      context.emit({
        agent: 'source_researcher',
        task: 'collect',
        phase: 'completed',
        message:
          scope.mode === 'demo'
            ? 'Synthetic source records loaded. No provider or model calls were made.'
            : 'Returned public evidence collected; missing values remain unknown.',
        resultCount: dataset.posts.length,
      });
      await pause();
      context.emit({
        agent: 'source_researcher',
        task: 'normalize',
        phase: 'started',
        message: 'Validating bounded source records, identities, and explicit relationship fields.',
      });
      const validated = socialDatasetSchema.parse(dataset);
      context.emit({
        agent: 'source_researcher',
        task: 'normalize',
        phase: 'completed',
        message:
          'Source records validated. Deduplication and boundary checks run with the analysis.',
        resultCount: validated.posts.length,
      });
      await pause();
      context.emit({
        agent: 'network_analyst',
        task: 'analyze',
        phase: 'started',
        message:
          'Combining message content with observed public references; keeping similarity links distinct.',
      });
      const analysis = analyzeSocialDataset(scope, validated);
      writeMissing('/research/network.json', networkArtifact(analysis));
      context.emit({
        agent: 'network_analyst',
        task: 'analyze',
        phase: 'completed',
        message: `Mapped ${analysis.coverage.observedRelationshipCount} observed references and ${analysis.coverage.inferredRelationshipCount} inferred wording links.`,
        resultCount: analysis.posts.length,
      });
      await pause();
      context.emit({
        agent: 'creative_strategist',
        task: 'brief',
        phase: 'started',
        message:
          'Extracting evidence-linked creative strengths, tradeoffs, and original script directions.',
      });
      writeMissing('/research/insights.json', insightsArtifact(analysis));
      writeMissing('/research/brief.md', briefArtifact(scope, analysis));
      context.emit({
        agent: 'creative_strategist',
        task: 'brief',
        phase: 'completed',
        message: 'Creative insights prepared with source limitations and reviewable script angles.',
        resultCount: analysis.insights.length,
      });
      await pause();
      context.emit({
        agent: 'coordinator',
        task: 'persist',
        phase: 'started',
        message: 'Saving the investigation and its evidence for later exploration.',
      });
      await pause();
      ensureActive(context.signal);
      return context.commit(async () => {
        const investigation = await repository.create(
          createInvestigation(scope, validated, analysis),
        );
        return investigation.id;
      });
    });
    response.status(202).location(`/api/social/research-runs/${run.id}`).json({ run });
  });
  router.get('/research-runs/:id', (request, response) =>
    response.json({ run: runs.get(uuid(request)) }),
  );
  router.delete('/research-runs/:id', (request, response) =>
    response.json({ run: runs.cancel(uuid(request)) }),
  );
  router.get('/research-runs/:id/artifacts', (request, response) => {
    const path = socialResearchArtifactPathSchema.safeParse(request.query.path);
    if (!path.success)
      throw new ApiError(
        404,
        'SOCIAL_ARTIFACT_NOT_FOUND',
        'Choose a public research artifact from this run.',
      );
    response.json({ artifact: runs.artifact(uuid(request), path.data) });
  });

  router.get('/providers', (_request, response) =>
    response.json({ providers: providers.statuses() }),
  );
  router.get('/investigations', async (request, response) => {
    if (
      request.query.summary !== undefined &&
      request.query.summary !== 'true' &&
      request.query.summary !== 'false'
    )
      throw new ApiError(400, 'SOCIAL_VALIDATION', 'Choose true or false for the summary option.');
    response.json({
      investigations:
        request.query.summary === 'true'
          ? await repository.listSummaries()
          : await repository.list(),
    });
  });
  router.post('/investigations', async (request, response) => {
    ensureResearchOpen();
    const input = validate(socialResearchInputSchema, request.body);
    if (legacyCollections.size + runs.activeCount >= 2)
      throw new ApiError(
        429,
        'SOCIAL_BUSY',
        'Two searches are already running. Wait for one to finish.',
      );
    const abort = new AbortController();
    let complete: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    legacyCollections.set(abort, done);
    let committing = false;
    const onClose = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.on('close', onClose);
    try {
      const dataset = await providers.collect(input, abort.signal);
      ensureResearchOpen();
      if (abort.signal.aborted) return;
      // Once the atomic save begins, shutdown waits for its truthful outcome.
      committing = true;
      const investigation = await repository.create(createInvestigation(input, dataset));
      response
        .status(201)
        .location(`/api/social/investigations/${investigation.id}`)
        .json({ investigation });
    } catch (error) {
      if (!committing && closing) ensureResearchOpen();
      throw error;
    } finally {
      response.off('close', onClose);
      legacyCollections.delete(abort);
      complete();
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
  return Object.assign(router, {
    closeSocialRuns: async () => {
      closing = true;
      for (const controller of legacyCollections.keys()) controller.abort();
      await Promise.all([runs.close(), ...legacyCollections.values()]);
    },
  });
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new ApiError(408, 'SOCIAL_RUN_CANCELED', 'The research run was canceled.');
}
function stepDelay(ms: number, signal: AbortSignal): Promise<void> {
  ensureActive(signal);
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new ApiError(408, 'SOCIAL_RUN_CANCELED', 'The research run was canceled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function tracedFetch(
  context: SocialResearchRunContext,
  fetcher: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (url, init) => {
    const host = new URL(String(url)).hostname;
    const provider =
      host === 'api.firecrawl.dev'
        ? 'firecrawl'
        : host === 'api.x.com'
          ? 'x'
          : host === 'api.x.ai'
            ? 'xai'
            : undefined;
    if (provider)
      context.emit({
        agent: 'source_researcher',
        task: 'collect',
        phase: 'started',
        message: `Requesting public evidence from ${provider === 'xai' ? 'Grok X search' : provider === 'x' ? 'X API' : 'Firecrawl'}.`,
        provider,
        search: context.input.topic,
      });
    try {
      const response = await fetcher(url, init);
      if (provider)
        context.emit({
          agent: 'source_researcher',
          task: 'collect',
          phase: response.ok ? 'progress' : 'failed',
          message: response.ok
            ? 'Provider responded; validating the returned public evidence.'
            : 'Provider access or usage prevented this request; other configured sources may still finish.',
          provider,
        });
      return response;
    } catch (error) {
      if (provider)
        context.emit({
          agent: 'source_researcher',
          task: 'collect',
          phase: 'failed',
          message: 'The public-data request did not finish. No provider error payload is exposed.',
          provider,
        });
      throw error;
    }
  };
}
function clipped(value: string, bytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= bytes) return value;
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  return `${decoder.decode(encoded.subarray(0, bytes - 3), { stream: true })}…`;
}
function sourcesArtifact(dataset: SocialDataset): string {
  const posts = dataset.posts
    .slice(0, 20)
    .map((post) => ({ ...post, text: clipped(post.text, 600) }));
  const value = () =>
    JSON.stringify(
      {
        kind: 'public_source_preview',
        totalItems: dataset.posts.length,
        omittedItems: dataset.posts.length - posts.length,
        posts,
      },
      null,
      2,
    );
  while (Buffer.byteLength(value(), 'utf8') > 60 * 1024 && posts.length) posts.pop();
  return value();
}
function networkArtifact(analysis: SocialAnalysis): string {
  const relationships = analysis.relationships.slice(0, 30);
  const communities = analysis.communities.slice(0, 12).map((community) => ({
    id: community.id,
    label: community.label,
    postCount: community.postIds.length,
    actorCount: community.actorIds.length,
    keywords: community.keywords,
  }));
  const value = () =>
    JSON.stringify(
      {
        methodology: analysis.methodology,
        coverage: analysis.coverage,
        communities,
        observedRelationshipPreview: relationships,
      },
      null,
      2,
    );
  while (Buffer.byteLength(value(), 'utf8') > 60 * 1024 && relationships.length)
    relationships.pop();
  // Coverage notices are bounded separately so unusual imported text cannot expand artifacts.
  if (Buffer.byteLength(value(), 'utf8') > 64 * 1024)
    return JSON.stringify({
      methodology: analysis.methodology,
      observedRelationshipCount: analysis.coverage.observedRelationshipCount,
      inferredRelationshipCount: analysis.coverage.inferredRelationshipCount,
      notice:
        'Detailed network metadata exceeds the artifact preview budget; inspect the saved investigation.',
    });
  return value();
}
function insightsArtifact(analysis: SocialAnalysis): string {
  const insights = analysis.insights.slice(0, 10);
  const value = () =>
    JSON.stringify({ interpretations: true, total: analysis.insights.length, insights }, null, 2);
  while (Buffer.byteLength(value(), 'utf8') > 60 * 1024 && insights.length) insights.pop();
  return value();
}
function briefArtifact(input: SocialResearchInput, analysis: SocialAnalysis): string {
  return clipped(
    `# Research direction: ${input.topic}\n\n${analysis.summary}\n\n${analysis.insights.map((insight) => `## ${insight.title}\n\n${insight.scriptAngle}\n\nSources: ${insight.evidenceIds.join(', ')}\n\nCautions: ${insight.cons.join(' ')}`).join('\n\n')}\n\nThese are interpretations of a bounded sample. Public source content and publication/collection dates remain in sources.json and the saved investigation. Creator selection is required before applying this direction to a script.`,
    60 * 1024,
  );
}
