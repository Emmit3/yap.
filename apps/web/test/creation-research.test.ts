import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { creatorResearchSchema } from '@yap/contracts/creator';
import { socialHandoffSchema } from '@yap/contracts/social';
import { createApp } from '../../api/src/app.js';
import {
  applyCreationResearch,
  creationContext,
  type CreationKind,
  type CreationResearchClients,
} from '../src/creation/research.js';
import { createCreatorApi } from '../src/creator/api.js';
import { createPromoApi, PromoApiError } from '../src/promo/api.js';

const handoff = socialHandoffSchema.parse({
  investigationId: '9eb97966-abd5-4710-b2b5-05b3aac6ba54',
  topic: 'Question openings in cafe films',
  audience: 'People interested in cafe videos',
  creativeDirection:
    'Adopt: Ask one original viewer question, then answer using our own verified information.',
  selectedNoteIds: ['18d37d83-c73f-44ae-94d4-18e0dd05c3ed'],
  selectedInsightIds: [],
  evidence: [
    {
      postId: 'public-cafe-reference',
      url: 'https://example.com/cafe-reference',
      excerpt: 'Another cafe advertises a 90 percent discount. This is their claim, not ours.',
      collectedAt: '2026-11-14T10:00:00.000Z',
      publishedAt: '2026-11-12T10:00:00.000Z',
      provider: 'import',
      contentKind: 'post',
    },
  ],
  sourceUrls: ['https://example.com/cafe-reference'],
  cautions: ['Use this reference for framing only. Its claims are not facts about our product.'],
});
const ownInput = 'Introduce our handmade ceramic cups using only our own product details.';
const ownBrief = {
  productName: 'Mori Ceramics',
  productDescription: 'Handmade ceramic cups from our Seattle studio.',
  audience: 'Neighbors who collect handmade ceramics',
  keyBenefits: ['Handmade cups', 'Made in our Seattle studio'],
  callToAction: 'Visit our studio this weekend.',
  imageDirection: 'Show the shape and glaze of our actual supplied cup.',
  platform: 'instagram' as const,
  duration: 15 as const,
  tone: 'conversational' as const,
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type RequestLog = { method: string; path: string };
async function fixture(t: TestContext, { holdAnalysis = false, holdRender = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-creation-research-'));
  const requests: RequestLog[] = [];
  const analysis = gate(),
    render = gate();
  if (!holdAnalysis) analysis.release();
  if (!holdRender) render.release();
  let paidCalls = 0,
    renderCalls = 0,
    analysisCalls = 0;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: Server | undefined;
  let origin = '';
  async function start() {
    app = await createApp({
      dataFile: join(directory, 'projects.json'),
      workflowProviderConfig: { provider: 'guided' },
      socialProviderConfig: {},
      creatorOptions: {
        analyze: async () => {
          analysisCalls++;
          await analysis.promise;
          return creatorResearchSchema.parse({
            summary: 'An isolated public research fixture.',
            productFacts: [],
            cinematography: '',
            sources: [],
            references: [],
            questions: [],
            limitations: ['No external providers are contacted by this fixture.'],
          });
        },
        video: {
          configured: false,
          async generate() {
            paidCalls++;
            throw new Error('Paid providers must not run in this test.');
          },
          async cancel() {},
        },
        auditor: {
          configured: false,
          async audit() {
            paidCalls++;
            throw new Error('Live auditors must not run in this test.');
          },
        },
        fetch: async () => {
          paidCalls++;
          throw new Error('Live source requests must not run in this test.');
        },
      },
      promoRenderer: async ({ workflow, outputPath }) => {
        renderCalls++;
        assert.ok(holdRender, 'Applying research must not start a render.');
        await render.promise;
        const bytes = Buffer.from('00000018ftypisom-creation-research-transport-fixture');
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, bytes);
        return {
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          width: 1080,
          height: 1920,
          duration: workflow.brief.duration!,
        };
      },
    });
    const handler = app;
    server = createServer((request, response) => {
      requests.push({
        method: request.method ?? 'GET',
        path: new URL(request.url ?? '/', 'http://local.test').pathname,
      });
      handler(request, response);
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    analysis.release();
    render.release();
    await app?.locals.shutdown();
    const active = server;
    if (active?.listening)
      await new Promise<void>((done, reject) =>
        active.close((error) => (error ? reject(error) : done())),
      );
  }
  t.after(async () => {
    await stop();
    const target = resolve(directory);
    assert.ok(
      target.startsWith(resolve(tmpdir()) + sep) &&
        basename(target).startsWith('yap-creation-research-'),
    );
    await rm(target, { recursive: true, force: true });
    assert.equal(paidCalls, 0, 'No source, model, generation, or audit provider was contacted.');
  });
  await start();
  return {
    requests,
    get clients() {
      return { creator: createCreatorApi(origin), promo: createPromoApi(origin) };
    },
    async restart() {
      await stop();
      await start();
    },
    releaseAnalysis: analysis.release,
    releaseRender: render.release,
    renderCalls: () => renderCalls,
    analysisCalls: () => analysisCalls,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function savedCreation(f: Fixture, kind: CreationKind, { photo = false } = {}) {
  const { promo, creator } = f.clients;
  let saved = await promo.create({ input: ownInput, brief: ownBrief });
  if (photo) {
    const jpeg = await readFile(
      new URL('../../../public/media/wall-beverage.jpg', import.meta.url),
    );
    saved = await promo.upload(
      saved.workflow.id,
      saved.workflow.version,
      new File([jpeg], 'Our actual cup.jpg', { type: 'image/jpeg' }),
    );
  }
  if (kind === 'photo') {
    saved = await promo.prepare(saved.workflow.id, { expectedVersion: saved.workflow.version });
    saved = await promo.approveAll(saved.workflow.id, saved.workflow.version);
    return { id: saved.workflow.id, workflow: saved.workflow };
  }
  let created = await creator.create({
    workflowId: saved.workflow.id,
    input: {
      mode: 'text',
      prompt: ownInput,
      urls: [],
      platform: ownBrief.platform,
      duration: ownBrief.duration,
      tone: ownBrief.tone,
    },
  });
  created = await creator.prepare(created.session.id, {
    expectedVersion: created.session.version,
    expectedWorkflowVersion: created.workflow.version,
  });
  const { quote } = await creator.quote(created.session.id, {
    expectedVersion: created.session.version,
    expectedWorkflowVersion: created.workflow.version,
  });
  created = await creator.approve(created.session.id, {
    expectedVersion: created.session.version,
    expectedWorkflowVersion: created.workflow.version,
    planId: created.session.plan!.id,
    reviewed: true,
    quoteId: quote.id,
    costReviewed: true,
  });
  return { id: created.session.id, workflow: created.workflow };
}

function assertHandoffOnly(requests: RequestLog[], workflowId: string) {
  assert.deepEqual(
    requests.filter((request) => request.method !== 'GET'),
    [{ method: 'POST', path: `/api/workflows/${workflowId}/refine` }],
  );
  assert.ok(
    !requests.some(
      (request) =>
        request.method !== 'GET' &&
        /\/(approve|approve-all|render|renders|produce|prepare)(?:\/|$)/.test(request.path),
    ),
  );
}

for (const kind of ['photo', 'video'] as const) {
  test(`${kind} research applies to the same saved workflow, preserving own facts and invalidating approved proposals`, async (t) => {
    const f = await fixture(t);
    const saved = await savedCreation(f, kind, { photo: kind === 'photo' });
    const workflowId = saved.workflow.id;
    assert.ok(saved.workflow.script && saved.workflow.scenes);
    assert.ok(Object.values(saved.workflow.approvals).every(Boolean));
    const context = await creationContext(kind, saved.id, new AbortController().signal, f.clients);
    assert.equal(context.topic, ownBrief.productName);
    assert.equal(context.audience, ownBrief.audience);
    const before = f.requests.length;
    const applied = await applyCreationResearch(
      kind,
      saved.id,
      handoff,
      new AbortController().signal,
      () => false,
      f.clients,
    );
    assertHandoffOnly(f.requests.slice(before), workflowId);
    assert.equal(applied.workflow.id, workflowId);
    assert.deepEqual(applied.workflow.brief, ownBrief);
    assert.equal(applied.workflow.input, ownInput);
    assert.deepEqual(applied.workflow.assets, saved.workflow.assets);
    assert.deepEqual(applied.workflow.research, handoff);
    assert.equal(applied.workflow.version, saved.workflow.version + 1);
    assert.equal(applied.workflow.contentRevision, saved.workflow.contentRevision + 1);
    assert.equal(applied.workflow.script, null);
    assert.equal(applied.workflow.scenes, null);
    assert.deepEqual(applied.workflow.approvals, { brief: null, script: null, scenes: null });
    assert.ok(!JSON.stringify(applied.workflow.brief).includes('90 percent'));
    assert.equal(f.renderCalls(), 0);
    assert.equal(f.analysisCalls(), 0);
    if (kind === 'video') {
      const reopened = await f.clients.creator.get(saved.id);
      assert.equal(reopened.session.workflowId, workflowId);
      assert.ok(
        !reopened.session.plan ||
          reopened.session.plan.workflowVersion !== reopened.workflow.version,
        'A stored old clip plan cannot describe the new research revision.',
      );
      assert.ok(
        !reopened.session.approval ||
          reopened.session.approval.workflowVersion !== reopened.workflow.version,
        'A stored old production approval cannot authorize the new workflow revision.',
      );
      assert.deepEqual((await f.clients.creator.jobs(saved.id)).jobs, []);
    }
    await f.restart();
    const persisted = await f.clients.promo.get(workflowId);
    assert.deepEqual(persisted.workflow, applied.workflow);
    const restored = await creationContext(kind, saved.id, new AbortController().signal, f.clients);
    assert.deepEqual(restored.research, handoff);
    assert.deepEqual(await f.clients.promo.getRenders(workflowId), []);
  });
}

test('dirty edits block all client reads and mutations before research attachment', async (t) => {
  const f = await fixture(t);
  const saved = await savedCreation(f, 'photo');
  const before = f.requests.length;
  await assert.rejects(
    applyCreationResearch(
      'photo',
      saved.id,
      handoff,
      new AbortController().signal,
      () => true,
      f.clients,
    ),
    /Save your creation edits/,
  );
  assert.deepEqual(f.requests.slice(before), []);
  assert.deepEqual((await f.clients.promo.get(saved.workflow.id)).workflow, saved.workflow);
});

test('edits becoming dirty while saved state loads prevent the later mutation', async (t) => {
  const f = await fixture(t);
  const saved = await savedCreation(f, 'photo');
  const clients = f.clients;
  const loaded = gate(),
    release = gate();
  t.after(release.release);
  let dirty = false;
  const guarded: CreationResearchClients = {
    ...clients,
    promo: {
      ...clients.promo,
      get: async (id, signal) => {
        const response = await clients.promo.get(id, signal);
        loaded.release();
        await release.promise;
        return response;
      },
    },
  };
  const before = f.requests.length;
  const pending = applyCreationResearch(
    'photo',
    saved.id,
    handoff,
    new AbortController().signal,
    () => dirty,
    guarded,
  );
  await loaded.promise;
  dirty = true;
  release.release();
  await assert.rejects(pending, /Save your creation edits/);
  assert.ok(f.requests.slice(before).every((request) => request.method === 'GET'));
  assert.deepEqual((await clients.promo.get(saved.workflow.id)).workflow, saved.workflow);
});

test('active video research blocks attachment without approving or producing anything', async (t) => {
  const f = await fixture(t, { holdAnalysis: true });
  const saved = await savedCreation(f, 'video');
  const clients = f.clients;
  const state = await clients.creator.get(saved.id);
  const started = await clients.creator.analyze(saved.id, state.session.version);
  assert.ok(['queued', 'running'].includes(started.job.status));
  const before = f.requests.length;
  await assert.rejects(
    applyCreationResearch(
      'video',
      saved.id,
      handoff,
      new AbortController().signal,
      () => false,
      clients,
    ),
    /Wait for the active research or video job/,
  );
  assert.ok(f.requests.slice(before).every((request) => request.method === 'GET'));
  assert.deepEqual((await clients.promo.get(saved.workflow.id)).workflow, saved.workflow);
  f.releaseAnalysis();
  for (let attempt = 0; attempt < 100; attempt++) {
    const { job } = await clients.creator.job(saved.id, started.job.id);
    if (!['queued', 'running'].includes(job.status)) break;
    await delay(5);
  }
  assert.equal(f.renderCalls(), 0);
});

test('active photo render receipts block attachment and preserve the approved source revision', async (t) => {
  const f = await fixture(t, { holdRender: true });
  const saved = await savedCreation(f, 'photo', { photo: true });
  const clients = f.clients;
  const job = await clients.promo.render(saved.id, saved.workflow.version);
  assert.ok(['queued', 'running'].includes(job.status));
  const before = f.requests.length;
  await assert.rejects(
    applyCreationResearch(
      'photo',
      saved.id,
      handoff,
      new AbortController().signal,
      () => false,
      clients,
    ),
    /Wait for the active research or video job/,
  );
  assert.ok(f.requests.slice(before).every((request) => request.method === 'GET'));
  assert.deepEqual((await clients.promo.get(saved.id)).workflow, saved.workflow);
  f.releaseRender();
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await clients.promo.getRender(saved.id, job.id);
    if (!['queued', 'running'].includes(current.status)) break;
    await delay(5);
  }
});

test('a workflow version conflict is surfaced once without retrying the research mutation', async (t) => {
  const f = await fixture(t);
  const saved = await savedCreation(f, 'photo');
  const clients = f.clients;
  let attempts = 0;
  const raced: CreationResearchClients = {
    ...clients,
    promo: {
      ...clients.promo,
      get: async (id, signal) => {
        const snapshot = await clients.promo.get(id, signal);
        await clients.promo.refine(
          id,
          {
            expectedVersion: snapshot.workflow.version,
            brief: { callToAction: 'Visit our studio next Sunday.' },
          },
          signal,
        );
        return snapshot;
      },
      refine: async (id, input, signal) => {
        attempts++;
        return clients.promo.refine(id, input, signal);
      },
    },
  };
  await assert.rejects(
    applyCreationResearch(
      'photo',
      saved.id,
      handoff,
      new AbortController().signal,
      () => false,
      raced,
    ),
    (error: unknown) =>
      error instanceof PromoApiError &&
      error.status === 409 &&
      error.code === 'WORKFLOW_VERSION_CONFLICT',
  );
  assert.equal(attempts, 1);
  const current = (await clients.promo.get(saved.id)).workflow;
  assert.equal(current.version, saved.workflow.version + 1);
  assert.equal(current.brief.callToAction, 'Visit our studio next Sunday.');
  assert.equal(current.research, undefined);
  assert.equal(f.renderCalls(), 0);
});
