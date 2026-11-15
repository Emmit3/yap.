import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import express from 'express';
import sharp from 'sharp';
import {
  creatorImageJobResponseSchema,
  creatorImageLibrarySchema,
  creatorImageQuoteResponseSchema,
  type CreatorImageJob,
  type CreatorImageSettings,
} from '@yap/contracts/creator-images';
import { CreatorRepository } from '../src/creator-repository.js';
import { WorkflowRepository } from '../src/workflow-repository.js';
import { WorkflowAssetStore } from '../src/workflow-assets.js';
import { createWorkflow } from '../src/workflow-engine.js';
import { createCreatorImagesRouter } from '../src/creator-images-router.js';
import { CreatorImageJobs } from '../src/creator-image-jobs.js';
import type { CreatorImageProvider } from '../src/creator-image-provider.js';
import { ApiError } from '../src/errors.js';

const settings: CreatorImageSettings = {
  prompt: 'A ceramic cup with its round handle on a pale studio plinth.',
  model: 'gpt-image-2.6-flare',
  quality: 'medium',
  size: '864x1536',
  complexity: 'low',
};
const image = () =>
  sharp({ create: { width: 864, height: 1536, channels: 3, background: '#ddd' } })
    .png()
    .toBuffer();
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(t: TestContext, provider: CreatorImageProvider, limitCents = 3000) {
  const root = resolve(tmpdir()),
    directory = await mkdtemp(join(root, 'yap-images-'));
  const file = join(directory, 'creator.json');
  const repository = await CreatorRepository.open(file, { limitCents });
  const workflows = await WorkflowRepository.open(join(directory, 'workflows.json'));
  const workflow = await workflows.create(
    createWorkflow({ input: 'Ceramic cup film', brief: { duration: 15 } }),
  );
  const now = new Date().toISOString();
  const session = await repository.create({
    id: randomUUID(),
    version: 1,
    workflowId: workflow.id,
    input: { mode: 'text', prompt: 'Ceramic cup film', urls: [] },
    answers: [],
    research: null,
    selectedReferenceIds: [],
    externalReferences: [],
    plan: null,
    approval: null,
    createdAt: now,
    updatedAt: now,
  });
  const options = {
    repository,
    workflows,
    assets: new WorkflowAssetStore(join(directory, 'uploads')),
    imageDirectory: join(directory, 'generated'),
    provider,
  };
  const images = await createCreatorImagesRouter(options);
  const app = express();
  app.use(express.json());
  app.use(images.router);
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      response.status(error instanceof ApiError ? error.status : 500).json({
        error: {
          code: error instanceof ApiError ? error.code : 'INTERNAL',
          message: error instanceof ApiError ? error.message : 'Internal error.',
        },
      });
    },
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/sessions/${session.id}/images`;
  t.after(async () => {
    await images.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.ok(resolve(directory).startsWith(root + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path = '', body?: unknown, method = body ? 'POST' : 'GET') =>
    fetch(base + path, {
      method,
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
  const quote = async (overrides: Partial<CreatorImageSettings> = {}) => {
    const response = await request('/quote', {
      expectedVersion: session.version,
      expectedWorkflowVersion: workflow.version,
      settings: { ...settings, ...overrides },
    });
    assert.equal(response.status, 200, await response.clone().text());
    return creatorImageQuoteResponseSchema.parse(await response.json()).quote;
  };
  const start = async (quoteId: string, requestId = randomUUID()) => {
    const response = await request('/jobs', {
      expectedVersion: session.version,
      expectedWorkflowVersion: workflow.version,
      quoteId,
      requestId,
      costReviewed: true,
    });
    assert.equal(response.status, 202, await response.clone().text());
    return creatorImageJobResponseSchema.parse(await response.json()).job;
  };
  const done = async (id: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await request(`/jobs/${id}`);
      const job = creatorImageJobResponseSchema.parse(await response.json()).job;
      if (['succeeded', 'failed', 'canceled'].includes(job.status)) return job;
      await delay(10);
    }
    throw new Error('Image job did not reach a terminal state.');
  };
  return {
    ...options,
    directory,
    file,
    session,
    workflow,
    images,
    base,
    request,
    quote,
    start,
    done,
  };
}

test('known image usage beyond its estimate is accounted for and pauses further paid work', async (t) => {
  const bytes = await image();
  let calls = 0;
  const f = await fixture(t, {
    configured: true,
    generate: async (request) => {
      calls++;
      await request.beforeSubmit();
      return {
        bytes,
        mimeType: 'image/png',
        usage: { textInputTokens: 500_000, imageInputTokens: 0, outputTokens: 100 },
      };
    },
  });
  const job = await f.done((await f.start((await f.quote()).id)).id);
  assert.equal(job.status, 'succeeded', 'a usable paid result remains available');
  assert.equal(job.reportedCostCents, 251);
  assert.match(job.costWarning!, /exceeded/);
  const budget = await f.repository.budget();
  assert.equal(budget.chargedCents, 251);
  assert.equal(budget.availableCents, 0);
  assert.ok(budget.pausedReason);
  await f.repository.recordImageCostOverrun(f.session.id, job.id, 251);
  assert.equal((await f.repository.budget()).chargedCents, 251, 'accounting is idempotent');
  await assert.rejects(
    f.repository.reserve({
      idempotencyKey: 'another-paid-call',
      category: 'image',
      sourceId: 'new-image',
      amountCents: 1,
    }),
    { code: 'CREATOR_BUDGET_PAUSED' },
  );
  const restarted = await CreatorRepository.open(f.file);
  assert.deepEqual(
    await restarted.budget(),
    budget,
    'the pause and measured usage survive restart',
  );
  assert.equal(calls, 1);
});

test('quoted image generation reserves before submission and saves an owned candidate without changing the film', async (t) => {
  const bytes = await image();
  let calls = 0;
  const f = await fixture(t, {
    configured: true,
    async generate(request) {
      calls++;
      assert.equal((await f.repository.budget()).reservedCents, 200);
      await request.beforeSubmit();
      const [receipt] = await f.repository.imageJobs(f.session.id);
      assert.ok(receipt?.submittedAt, 'submission intent must be durable before dispatch');
      return {
        bytes,
        mimeType: 'image/png',
        usage: { textInputTokens: 1000, imageInputTokens: 0, outputTokens: 1000 },
      };
    },
  });
  const quote = await f.quote();
  assert.equal(quote.maxCostCents, 200);
  assert.equal(Date.parse(quote.expiresAt) - Date.parse(quote.createdAt), 600_000);
  const job = await f.start(quote.id);
  const finished = await f.done(job.id);
  assert.equal(finished.status, 'succeeded');
  const library = creatorImageLibrarySchema.parse(await (await f.request()).json());
  assert.equal(library.variants.length, 1);
  const variant = library.variants[0]!;
  assert.equal(variant.kind, 'generated');
  assert.equal(variant.settings.model, settings.model);
  assert.equal(variant.sourceSha256, null);
  assert.equal((await f.repository.get(f.session.id)).version, 1);
  assert.equal((await f.workflows.get(f.workflow.id)).assets.length, 0);
  assert.deepEqual(
    Buffer.from(await (await f.request(`/${variant.id}/file`)).arrayBuffer()),
    bytes,
  );
  assert.equal((await f.repository.budget()).chargedCents, 4);
  await f.repository.update(f.session.id, 1, (session) => session);
  const retried = await f.start(quote.id, job.requestId);
  assert.equal(retried.id, job.id, 'same request resolves before stale version checks');
  assert.equal(calls, 1);
  const conflict = await f.request('/jobs', {
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    quoteId: randomUUID(),
    requestId: job.requestId,
    costReviewed: true,
  });
  assert.equal(conflict.status, 409);
});

test('editing preserves generated-image lineage and rejects cross-creation references', async (t) => {
  const bytes = await image();
  let calls = 0;
  const f = await fixture(t, {
    configured: true,
    async generate(request) {
      if (calls++) assert.deepEqual(request.image, bytes);
      await request.beforeSubmit();
      return { bytes, mimeType: 'image/png' };
    },
  });
  const first = await f.done((await f.start((await f.quote()).id)).id);
  assert.ok(first.variantId);
  const editQuote = await f.quote({ parentVariantId: first.variantId });
  const parent = await f.repository.imageVariant(f.session.id, first.variantId);
  assert.equal(editQuote.sourceSha256, parent.media.sha256);
  const edited = await f.done((await f.start(editQuote.id)).id);
  assert.equal(edited.status, 'succeeded');
  const variant = await f.repository.imageVariant(f.session.id, edited.variantId!);
  assert.equal(variant.kind, 'edited');
  assert.equal(variant.settings.parentVariantId, first.variantId);
  assert.equal(variant.sourceSha256, parent.media.sha256);
  const missing = await f.request('/quote', {
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    settings: { ...settings, parentVariantId: randomUUID() },
  });
  assert.equal(missing.status, 404);
});

test('concurrent starts with one request ID cannot acknowledge a different image quote', async (t) => {
  const bytes = await image();
  let calls = 0;
  const f = await fixture(t, {
    configured: true,
    async generate(request) {
      calls++;
      await request.beforeSubmit();
      return { bytes, mimeType: 'image/png' };
    },
  });
  const firstQuote = await f.quote();
  const otherQuote = await f.quote({ prompt: 'A different proposed ceramic cup composition.' });
  const jobs = new CreatorImageJobs(f);
  const admitted = latch(),
    release = latch(),
    secondRead = latch();
  const withSession = f.repository.withSession.bind(f.repository);
  const imageJobs = f.repository.imageJobs.bind(f.repository);
  let reads = 0;
  f.repository.withSession = async (id, operation) => {
    admitted.release();
    await release.promise;
    return withSession(id, operation);
  };
  f.repository.imageJobs = async (id) => {
    const result = await imageJobs(id);
    if (++reads === 2) secondRead.release();
    return result;
  };
  t.after(async () => {
    release.release();
    await jobs.close();
  });
  const requestId = randomUUID();
  const first = jobs.start(f.session.id, {
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    quoteId: firstQuote.id,
    requestId,
    costReviewed: true,
  });
  await admitted.promise;
  const second = jobs.start(f.session.id, {
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    quoteId: otherQuote.id,
    requestId,
    costReviewed: true,
  });
  const results = Promise.allSettled([first, second]);
  await secondRead.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await imageJobs(f.session.id)).length,
    0,
    'admission barrier keeps both starts ahead of persistence',
  );
  release.release();
  const [accepted, conflict] = await results;
  assert.equal(accepted.status, 'fulfilled');
  assert.equal(conflict.status, 'rejected');
  if (conflict.status === 'rejected')
    assert.equal(conflict.reason.code, 'CREATOR_IMAGE_REQUEST_CONFLICT');
  assert.equal((await imageJobs(f.session.id)).length, 1);
  // Let the one accepted operation finish; no second quote can authorize a dispatch.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (['succeeded', 'failed'].includes((await imageJobs(f.session.id))[0]!.status)) break;
    await delay(10);
  }
  assert.equal(calls, 1);
});

test('a workflow edit during provider preparation stops submission and refunds the unused hold', async (t) => {
  const entered = latch(),
    release = latch();
  t.after(() => release.release());
  const bytes = await image();
  let dispatched = 0;
  const f = await fixture(t, {
    configured: true,
    async generate(request) {
      entered.release();
      await release.promise;
      await request.beforeSubmit();
      dispatched++;
      return { bytes, mimeType: 'image/png' };
    },
  });
  const job = await f.start((await f.quote()).id);
  await entered.promise;
  await f.workflows.update(f.workflow.id, 1, (workflow) => ({
    ...workflow,
    title: 'Changed after quote',
  }));
  release.release();
  const failed = await f.done(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.submittedAt, null);
  assert.equal(dispatched, 0);
  assert.equal((await f.repository.budget()).availableCents, 3000);
});

test('known provider rejection refunds a hold while unknown submission outcomes stay reserved', async (t) => {
  for (const known of [true, false]) {
    await t.test(known ? 'known rejection' : 'unknown outcome', async (t) => {
      let calls = 0;
      const f = await fixture(t, {
        configured: true,
        async generate(request) {
          calls++;
          await request.beforeSubmit();
          if (known)
            throw new ApiError(
              502,
              'CREATOR_IMAGE_REJECTED',
              'The provider rejected this image request.',
            );
          throw new Error('Unknown connection ended');
        },
      });
      const quote = await f.quote(),
        job = await f.start(quote.id);
      const failed = await f.done(job.id);
      assert.equal(failed.status, 'failed');
      assert.ok(failed.submittedAt);
      assert.equal((await f.repository.budget()).reservedCents, known ? 0 : 200);
      assert.equal((await f.start(quote.id, job.requestId)).id, job.id);
      assert.equal(calls, 1);
    });
  }
});

test('cancellation retains submitted costs and does not save a late image result', async (t) => {
  const submitted = latch(),
    release = latch(),
    bytes = await image();
  t.after(() => release.release());
  const f = await fixture(t, {
    configured: true,
    async generate(request) {
      await request.beforeSubmit();
      submitted.release();
      await release.promise;
      return { bytes, mimeType: 'image/png' };
    },
  });
  const job = await f.start((await f.quote()).id);
  await submitted.promise;
  const canceled = creatorImageJobResponseSchema.parse(
    await (await f.request(`/jobs/${job.id}`, undefined, 'DELETE')).json(),
  ).job;
  assert.equal(canceled.status, 'canceled');
  release.release();
  await f.images.close();
  assert.equal((await f.repository.imageVariants(f.session.id)).length, 0);
  assert.equal((await f.repository.budget()).reservedCents, 200);
});

test('image quotes require current clip ownership, current versions and available budget before a paid call', async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    {
      configured: true,
      async generate() {
        calls++;
        throw new Error('Unexpected provider call');
      },
    },
    199,
  );
  const missingClip = await f.request('/quote', {
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    settings: { ...settings, clipId: randomUUID() },
  });
  assert.equal(missingClip.status, 409);
  const noBudget = await f.request('/quote', {
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    settings,
  });
  assert.equal(noBudget.status, 409);
  assert.equal(calls, 0);
});

test('restart marks image work interrupted without replay and keeps only submitted holds', async (t) => {
  for (const submitted of [true, false]) {
    await t.test(submitted ? 'submitted hold retained' : 'unsubmitted hold released', async (t) => {
      const f = await fixture(t, {
        configured: false,
        async generate() {
          throw new Error('No provider dispatch allowed');
        },
      });
      const now = new Date().toISOString();
      const quote = await f.repository.addImageQuote({
        id: randomUUID(),
        sessionId: f.session.id,
        sessionVersion: 1,
        workflowVersion: 1,
        settings,
        sourceSha256: null,
        maxCostCents: 200,
        currency: 'USD',
        createdAt: now,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        consumedByJobId: null,
      });
      const job = await f.repository.addImageJob(
        {
          id: randomUUID(),
          sessionId: f.session.id,
          requestId: randomUUID(),
          quoteId: quote.id,
          sourceVersion: 1,
          workflowVersion: 1,
          settings,
          status: 'running',
          maxCostCents: 200,
          submittedAt: submitted ? now : null,
          variantId: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        },
        1,
      );
      const reopened = await CreatorRepository.open(f.file);
      const interrupted = await reopened.imageJob(f.session.id, job.id);
      assert.equal(interrupted.status, 'failed');
      assert.equal(interrupted.error?.code, 'CREATOR_IMAGE_INTERRUPTED');
      assert.equal((await reopened.budget()).reservedCents, submitted ? 200 : 0);
      // The original owner performs no further mutations after the recovered owner opens.
    });
  }
});

test('image admission allows two global workers and one active request per creation', async (t) => {
  const release = latch(),
    bytes = await image();
  t.after(() => release.release());
  let calls = 0;
  const f = await fixture(t, {
    configured: true,
    async generate(request) {
      calls++;
      await request.beforeSubmit();
      await release.promise;
      return { bytes, mimeType: 'image/png' };
    },
  });
  await f.start((await f.quote()).id);
  const another = await f.quote();
  const sameSession = await f.request('/jobs', {
    expectedVersion: 1,
    expectedWorkflowVersion: 1,
    quoteId: another.id,
    requestId: randomUUID(),
    costReviewed: true,
  });
  assert.equal(sameSession.status, 409);
  for (const expectedStatus of [202, 429]) {
    const session = await f.repository.create({ ...f.session, id: randomUUID() });
    const address = f.base.replace(f.session.id, session.id);
    const post = (path: string, body: unknown) =>
      fetch(address + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const quote = creatorImageQuoteResponseSchema.parse(
      await (
        await post('/quote', {
          expectedVersion: 1,
          expectedWorkflowVersion: 1,
          settings,
        })
      ).json(),
    ).quote;
    const response = await post('/jobs', {
      expectedVersion: 1,
      expectedWorkflowVersion: 1,
      quoteId: quote.id,
      requestId: randomUUID(),
      costReviewed: true,
    });
    assert.equal(response.status, expectedStatus);
  }
  release.release();
  await f.images.close();
  assert.equal(calls, 2);
});

test('image files are served only after hash verification and the unconfigured library remains readable', async (t) => {
  const bytes = await image();
  const f = await fixture(t, {
    configured: true,
    async generate(request) {
      await request.beforeSubmit();
      return { bytes, mimeType: 'image/png' };
    },
  });
  const finished = await f.done((await f.start((await f.quote()).id)).id);
  const variant = await f.repository.imageVariant(f.session.id, finished.variantId!);
  await writeFile(
    join(f.imageDirectory, f.session.id, `${variant.media.id}.png`),
    Buffer.from('changed'),
  );
  assert.equal((await f.request(`/${variant.id}/file`)).status, 500);
  const empty = await fixture(t, {
    configured: false,
    async generate() {
      throw new Error('No provider');
    },
  });
  assert.deepEqual(creatorImageLibrarySchema.parse(await (await empty.request()).json()), {
    configured: false,
    variants: [],
    jobs: [],
  });
});
