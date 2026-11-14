import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  socialInvestigationSummariesResponseSchema,
  socialResearchRunResponseSchema,
} from '@yap/contracts/social';
import { workflowResponseSchema } from '@yap/contracts/workflow';
import { createApp } from '../src/app.js';

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
