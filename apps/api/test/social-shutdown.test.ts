import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  socialInvestigationResponseSchema,
  socialInvestigationSummariesResponseSchema,
  socialResearchRunResponseSchema,
} from '@yap/contracts/social';
import { workflowResponseSchema } from '@yap/contracts/workflow';
import { createApp } from '../src/app.js';
import { SocialRepository } from '../src/social-repository.js';

const legacyInput = {
  topic: 'Coffee filter demonstrations',
  platforms: ['web'],
  mode: 'live',
  limit: 1,
};

async function legacyFixture(t: TestContext, fetcher: typeof globalThis.fetch) {
  const prefix = join(tmpdir(), 'yap-legacy-shutdown-');
  const directory = await mkdtemp(prefix);
  const socialDataFile = join(directory, 'research.json');
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    socialDataFile,
    workflowProviderConfig: { provider: 'guided' },
    socialProviderConfig: { firecrawlApiKey: 'test-server-key' },
    socialFetch: fetcher,
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.locals.shutdown();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    assert.ok(directory.startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/social`;
  return {
    app,
    socialDataFile,
    search: () =>
      fetch(`${base}/investigations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyInput),
      }),
    summaries: async () =>
      socialInvestigationSummariesResponseSchema.parse(
        await (await fetch(`${base}/investigations?summary=true`)).json(),
      ).investigations,
  };
}

function providerResult(): Response {
  return Response.json({
    success: true,
    data: {
      web: [
        {
          url: 'https://example.com/coffee-filter',
          title: 'A coffee filter demonstration',
          description: 'A public example explains how to show the coffee filter process.',
        },
      ],
    },
  });
}

test(
  'app shutdown aborts public research and retains the main workflow cleanup',
  { timeout: 10000 },
  async (t) => {
    const prefix = join(tmpdir(), 'yap-social-shutdown-');
    const directory = await mkdtemp(prefix);
    const socialDataFile = join(directory, 'research.json');
    let requestSignal: AbortSignal | undefined;
    let requestAborted = false;
    let announceRequest = () => {};
    const requestStarted = new Promise<void>((resolve) => {
      announceRequest = resolve;
    });
    const app = await createApp({
      dataFile: join(directory, 'projects.json'),
      socialDataFile,
      workflowProviderConfig: { provider: 'guided' },
      socialProviderConfig: { firecrawlApiKey: 'test-server-key' },
      socialFetch: async (_url, init) => {
        assert.ok(init?.signal);
        requestSignal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            requestAborted = true;
            reject(new DOMException('Research request aborted by shutdown.', 'AbortError'));
          };
          requestSignal!.addEventListener('abort', abort, { once: true });
          announceRequest();
          if (requestSignal!.aborted) abort();
        });
      },
    });
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => {
      await app.locals.shutdown();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      assert.ok(directory.startsWith(prefix));
      await rm(directory, { recursive: true, force: true });
    });
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const workflowResponse = await post('/workflows', {
      input: 'Make a promo about our coffee filter.',
    });
    assert.equal(workflowResponse.status, 201);
    const { workflow } = workflowResponseSchema.parse(await workflowResponse.json());
    const startedResponse = await post('/social/research-runs', {
      topic: 'Coffee filter demonstrations',
      platforms: ['web'],
      mode: 'live',
      harness: 'pipeline',
      limit: 5,
    });
    assert.equal(startedResponse.status, 202);
    const { run: started } = socialResearchRunResponseSchema.parse(await startedResponse.json());
    await Promise.race([
      requestStarted,
      delay(2000).then(() => {
        throw new Error('The public research request did not start.');
      }),
    ]);
    assert.equal(requestAborted, false);
    await app.locals.shutdown();
    assert.equal(requestAborted, true);
    assert.equal(requestSignal?.aborted, true);
    const { run } = socialResearchRunResponseSchema.parse(
      await (await fetch(`${base}/social/research-runs/${started.id}`)).json(),
    );
    assert.equal(run.status, 'canceled');
    assert.equal(run.investigationId, null);
    const summaries = socialInvestigationSummariesResponseSchema.parse(
      await (await fetch(`${base}/social/investigations?summary=true`)).json(),
    );
    assert.deepEqual(summaries.investigations, []);
    const saved = await readFile(socialDataFile, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '[]';
      throw error;
    });
    assert.deepEqual(JSON.parse(saved), []);
    // This response changes to approval validation if workflow.close() was lost from composition.
    const renderAfterShutdown = await post(`/workflows/${workflow.id}/renders`, {
      expectedVersion: workflow.version,
    });
    assert.equal(renderAfterShutdown.status, 503);
    assert.equal((await renderAfterShutdown.json()).error.code, 'RENDER_UNAVAILABLE');
  },
);

test(
  'shutdown aborts and drains a legacy search before saving, then rejects new searches',
  { timeout: 10000 },
  async (t) => {
    let providerSignal: AbortSignal | undefined;
    let providerAborted = false;
    let providerSettled = false;
    let providerCalls = 0;
    let announceRequest: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      announceRequest = resolve;
    });
    const fixture = await legacyFixture(t, async (_url, init) => {
      providerCalls++;
      assert.ok(init?.signal);
      providerSignal = init.signal;
      try {
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            providerAborted = true;
            reject(new DOMException('Provider request aborted by shutdown.', 'AbortError'));
          };
          providerSignal!.addEventListener('abort', abort, { once: true });
          announceRequest();
          if (providerSignal!.aborted) abort();
        });
      } finally {
        providerSettled = true;
      }
    });
    const pendingResponse = fixture.search();
    await Promise.race([
      started,
      delay(2000).then(() => {
        throw new Error('Legacy search did not start.');
      }),
    ]);
    assert.equal(providerAborted, false);
    await fixture.app.locals.shutdown();
    assert.equal(providerSignal?.aborted, true);
    assert.equal(providerAborted, true);
    assert.equal(providerSettled, true);
    const response = await pendingResponse;
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'SOCIAL_RUN_CLOSED');
    assert.deepEqual(await fixture.summaries(), []);
    const saved = await readFile(fixture.socialDataFile, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '[]';
      throw error;
    });
    assert.deepEqual(JSON.parse(saved), []);
    const rejected = await fixture.search();
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error.code, 'SOCIAL_RUN_CLOSED');
    assert.equal(providerCalls, 1);
  },
);

test(
  'shutdown waits for a legacy atomic save that already began and reports its saved outcome',
  { timeout: 10000 },
  async (t) => {
    const originalCreate = SocialRepository.prototype.create;
    let releaseSave: () => void = () => {};
    let announceSave: () => void = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saveStarted = new Promise<void>((resolve) => {
      announceSave = resolve;
    });
    SocialRepository.prototype.create = async function (investigation) {
      announceSave();
      await saveGate;
      return originalCreate.call(this, investigation);
    };
    try {
      const fixture = await legacyFixture(t, async () => providerResult());
      const pendingResponse = fixture.search();
      await Promise.race([
        saveStarted,
        delay(2000).then(() => {
          throw new Error('Legacy atomic save did not start.');
        }),
      ]);
      const closing = fixture.app.locals.shutdown();
      const outcome = await Promise.race([
        closing.then(() => 'closed'),
        delay(20).then(() => 'waiting'),
      ]);
      assert.equal(outcome, 'waiting');
      const rejected = await fixture.search();
      assert.equal(rejected.status, 503);
      releaseSave();
      await closing;
      const response = await pendingResponse;
      assert.equal(response.status, 201);
      const { investigation } = socialInvestigationResponseSchema.parse(await response.json());
      assert.deepEqual(
        (await fixture.summaries()).map((item) => item.id),
        [investigation.id],
      );
      const saved = JSON.parse(await readFile(fixture.socialDataFile, 'utf8'));
      assert.equal(saved.length, 1);
      assert.equal(saved[0].id, investigation.id);
    } finally {
      releaseSave();
      SocialRepository.prototype.create = originalCreate;
    }
  },
);
