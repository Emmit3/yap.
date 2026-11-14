import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  creatorSessionResponseSchema,
  creatorJobResponseSchema,
  creatorQuoteResponseSchema,
  type CreatorResearch,
  type CreatorSessionResponse,
} from '@yap/contracts/creator';
import { createApp, type AppOptions } from '../src/app.js';
import { createWorkflowProvider } from '../src/workflow-provider.js';

const research: CreatorResearch = {
  summary: 'Public source review.',
  productFacts: [],
  cinematography: 'Use motivated side lighting and a restrained push in.',
  sources: [
    {
      id: 'source',
      url: 'https://example.com/director',
      title: 'Director case study',
      kind: 'cinematography',
      excerpt: 'A documented studio lighting technique.',
    },
  ],
  references: [
    {
      id: 'reference',
      sourceIds: ['source'],
      title: 'Product reveal',
      hook: 'Reveal a detail first.',
      visualDirection: 'A slow reveal from a close detail to the subject.',
      rationale: 'The technique fits the requested tactile subject.',
    },
  ],
  questions: [],
  limitations: [],
};
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
async function fixture(
  t: TestContext,
  creatorOptions: AppOptions['creatorOptions'] = {},
  overrides: Partial<AppOptions> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-creator-test-'));
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    creatorOptions: {
      analyze: async () => research,
      video: {
        configured: false,
        cancel: async () => {},
        generate: async () => {
          throw new Error('Live generation is forbidden in this test.');
        },
      },
      auditor: {
        configured: false,
        audit: async () => {
          throw new Error('Live review is forbidden in this test.');
        },
      },
      ...creatorOptions,
    },
    ...overrides,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, request: (path: string, init?: RequestInit) => fetch(base + path, init) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function session(response: Response, status = 200): Promise<CreatorSessionResponse> {
  assert.equal(response.status, status, await response.clone().text());
  return creatorSessionResponseSchema.parse(await response.json());
}
async function create(f: Fixture) {
  return session(
    await f.request(
      '/creator/sessions',
      json('POST', {
        input: {
          mode: 'text',
          prompt: 'A cinematic film for handmade ceramic cups.',
          urls: [],
          duration: 15,
          platform: 'tiktok',
          tone: 'bold',
        },
      }),
    ),
    201,
  );
}
async function poll(f: Fixture, id: string, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await f.request(`/creator/sessions/${id}/jobs/${jobId}`);
    assert.equal(response.status, 200);
    const data = creatorJobResponseSchema.parse(await response.json());
    if (['succeeded', 'failed', 'canceled'].includes(data.job.status)) return data;
    await delay(5);
  }
  throw new Error('Job did not finish.');
}

test('creator session persists explicit interview/references, prepares bounded editable clips, and never auto-approves', async (t) => {
  const f = await fixture(t);
  let current = await create(f),
    id = current.session.id;
  assert.equal(current.workflow.brief.duration, 15);
  assert.equal(current.workflow.brief.platform, 'tiktok');
  assert.equal(current.workflow.brief.tone, 'bold');
  assert.equal(
    current.workflow.questions.find((question) => question.id === 'audience')?.status,
    'open',
  );
  current = await session(
    await f.request(
      `/creator/sessions/${id}`,
      json('PATCH', {
        expectedVersion: current.session.version,
        answers: [
          { questionId: 'productName', answer: 'Moss Ceramic' },
          { questionId: 'audience', answer: 'People who enjoy handmade tableware' },
          { questionId: 'imageDirection', answer: 'Make the glazed surfaces the focus.' },
          { questionId: 'style', answer: 'Warm monochrome.' },
          { questionId: 'location', answer: 'A quiet pottery studio' },
        ],
      }),
    ),
  );
  const started = creatorJobResponseSchema.parse(
    await (
      await f.request(
        `/creator/sessions/${id}/analyze`,
        json('POST', { expectedVersion: current.session.version }),
      )
    ).json(),
  );
  assert.equal(started.job.status, 'queued');
  assert.equal((await poll(f, id, started.job.id)).job.status, 'succeeded');
  current = await session(await f.request(`/creator/sessions/${id}`));
  current = await session(
    await f.request(
      `/creator/sessions/${id}`,
      json('PATCH', {
        expectedVersion: current.session.version,
        selectedReferenceIds: ['reference'],
        externalReferences: [
          {
            id: 'catalog',
            title: 'Independent product case',
            url: 'https://example.com/case',
            watchUrl: 'https://example.com/watch',
            techniques: ['A controlled macro reveal'],
            whyItFits: 'Tactile materials',
            evidence: 'Published studio case study',
            usage: 'external_reference',
          },
        ],
      }),
    ),
  );
  current = await session(
    await f.request(
      `/creator/sessions/${id}/prepare`,
      json('POST', {
        expectedVersion: current.session.version,
        expectedWorkflowVersion: current.workflow.version,
      }),
    ),
  );
  assert.equal(current.session.plan?.clips.length, 3);
  assert.equal(current.session.plan?.maxGeneratedSeconds, 30);
  assert.equal(current.session.approval, null);
  assert.equal(current.workflow.approvals.script, null);
  assert.match(current.session.plan!.clips[0]!.prompt, /quiet pottery studio/i);
  assert.match(current.session.plan!.clips[0]!.camera, /spatial/i);
  assert.match(current.workflow.brief.imageDirection!, /glazed surfaces/);
  assert.match(current.workflow.brief.imageDirection!, /Warm monochrome/);
  assert.ok(
    current.workflow.scenes?.scenes.some((scene) =>
      scene.visual.includes('https://example.com/case'),
    ),
  );
  let response = await f.request(
    `/creator/sessions/${id}/approve`,
    json('POST', {
      expectedVersion: current.session.version,
      expectedWorkflowVersion: current.workflow.version,
      planId: current.session.plan!.id,
      reviewed: false,
    }),
  );
  assert.equal(response.status, 400);
  const quoteResponse = await f.request(
    '/creator/sessions/' + id + '/quote',
    json('POST', {
      expectedVersion: current.session.version,
      expectedWorkflowVersion: current.workflow.version,
    }),
  );
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const { quote } = creatorQuoteResponseSchema.parse(await quoteResponse.json());
  current = await session(
    await f.request(
      `/creator/sessions/${id}/approve`,
      json('POST', {
        expectedVersion: current.session.version,
        expectedWorkflowVersion: current.workflow.version,
        planId: current.session.plan!.id,
        reviewed: true,
        costReviewed: true,
        quoteId: quote.id,
      }),
    ),
  );
  assert.equal(current.session.plan?.workflowVersion, current.workflow.version);
  assert.equal(current.session.approval?.workflowVersion, current.workflow.version);
  response = await f.request(
    `/creator/sessions/${id}/produce`,
    json('POST', {
      expectedVersion: current.session.version,
      approvalId: current.session.approval!.id,
      quoteId: current.session.approval!.quoteId!,
      requestId: randomUUID(),
    }),
  );
  assert.equal(response.status, 503);
  const version = current.session.version;
  current = await session(
    await f.request(
      `/creator/sessions/${id}`,
      json('PATCH', {
        expectedVersion: version,
        answers: [{ questionId: 'audience', answer: 'A different audience' }],
      }),
    ),
  );
  assert.equal(current.session.approval, null);
  assert.equal(current.session.plan, null);
  response = await f.request(
    `/creator/sessions/${id}`,
    json('PATCH', { expectedVersion: version, answers: [] }),
  );
  assert.equal(response.status, 409);
});

test('creator/workflow prepare commits together before a concurrent session edit can mutate either store', async (t) => {
  const guided = createWorkflowProvider({ provider: 'guided' });
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const f = await fixture(
    t,
    {},
    {
      workflowProvider: {
        ...guided,
        script: async (workflow, signal) => {
          entered();
          await gate;
          return guided.script(workflow, signal);
        },
      },
    },
  );
  const current = await create(f),
    id = current.session.id;
  const preparing = f.request(
    `/creator/sessions/${id}/prepare`,
    json('POST', {
      expectedVersion: current.session.version,
      expectedWorkflowVersion: current.workflow.version,
    }),
  );
  await enteredPromise;
  const editing = f.request(
    `/creator/sessions/${id}`,
    json('PATCH', {
      expectedVersion: current.session.version,
      answers: [{ questionId: 'audience', answer: 'A simultaneous answer' }],
    }),
  );
  release();
  const prepared = await session(await preparing);
  assert.ok(prepared.session.plan);
  assert.ok(prepared.workflow.script);
  assert.equal((await editing).status, 409);
  const loaded = await session(await f.request(`/creator/sessions/${id}`));
  assert.equal(loaded.session.plan?.workflowVersion, loaded.workflow.version);
  assert.equal(loaded.session.plan?.scriptId, loaded.workflow.script?.id);
});

test('research permits parallel interview answers, preserves a newer plan, and rejects changed source input', async (t) => {
  let release: ((value: CreatorResearch) => void) | undefined;
  const f = await fixture(t, {
    analyze: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  let current = await create(f),
    id = current.session.id;
  let response = await f.request(
    `/creator/sessions/${id}/analyze`,
    json('POST', { expectedVersion: current.session.version }),
  );
  const started = creatorJobResponseSchema.parse(await response.json());
  current = await session(
    await f.request(
      `/creator/sessions/${id}`,
      json('PATCH', {
        expectedVersion: current.session.version,
        answers: [{ questionId: 'productName', answer: 'The later answer' }],
      }),
    ),
  );
  current = await session(
    await f.request(
      `/creator/sessions/${id}/prepare`,
      json('POST', {
        expectedVersion: current.session.version,
        expectedWorkflowVersion: current.workflow.version,
      }),
    ),
  );
  const planId = current.session.plan!.id;
  assert.ok(release);
  release(research);
  const done = await poll(f, id, started.job.id);
  assert.equal(done.job.status, 'succeeded');
  assert.equal(done.session.answers[0]?.answer, 'The later answer');
  assert.equal(done.session.plan?.id, planId);
  assert.ok(done.session.research?.limitations.some((item) => item.includes('later interview')));
  current = await session(await f.request(`/creator/sessions/${id}`));
  release = undefined;
  response = await f.request(
    `/creator/sessions/${id}/analyze`,
    json('POST', { expectedVersion: current.session.version }),
  );
  const second = creatorJobResponseSchema.parse(await response.json());
  for (let index = 0; index < 100 && !release; index++) await delay(5);
  assert.ok(release);
  current = await session(
    await f.request(
      `/creator/sessions/${id}`,
      json('PATCH', {
        expectedVersion: current.session.version,
        input: { ...current.session.input, prompt: 'An entirely different film idea' },
      }),
    ),
  );
  release!(research);
  const stale = await poll(f, id, second.job.id);
  assert.equal(stale.job.status, 'failed');
  assert.equal(stale.job.error?.code, 'CREATOR_ANALYSIS_STALE');
  assert.equal(stale.session.input.prompt, 'An entirely different film idea');
  assert.equal(stale.session.research, null);
});
