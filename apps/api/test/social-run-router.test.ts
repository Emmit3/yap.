import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import {
  socialInvestigationResponseSchema,
  socialResearchArtifactResponseSchema,
  socialResearchCapabilitiesSchema,
  socialResearchRunResponseSchema,
  type SocialResearchRun,
} from '@yap/contracts/social';
import { ApiError } from '../src/errors.js';
import { createSocialRouter, type SocialRouterOptions } from '../src/social-router.js';

async function fixture(t: TestContext, options: Partial<SocialRouterOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-social-runs-'));
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  const router = await createSocialRouter({
    dataFile: join(directory, 'research.json'),
    config: {},
    demoStepDelayMs: 0,
    ...options,
  });
  app.use('/api/social', router);
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) =>
    response.status(error instanceof ApiError ? error.status : 500).json({
      error: {
        code: error instanceof ApiError ? error.code : 'INTERNAL',
        message: error instanceof ApiError ? error.message : 'Unexpected server error',
      },
    });
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/social`;
  t.after(async () => {
    await router.closeSocialRuns();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const poll = async (id: string): Promise<SocialResearchRun> => {
    for (let index = 0; index < 100; index++) {
      const { run } = socialResearchRunResponseSchema.parse(
        await (await request(`/research-runs/${id}`)).json(),
      );
      if (['completed', 'failed', 'canceled'].includes(run.status)) return run;
      await delay(5);
    }
    throw new Error('Research run did not finish');
  };
  return { request, poll };
}
const input = {
  topic: 'Beginner coffee experiments',
  platforms: ['x'],
  mode: 'demo',
  limit: 8,
  harness: 'deepagents',
};
test('no-key example replays actual stages and exposes inspectable public artifacts without calling model or providers', async (t) => {
  let requests = 0;
  let models = 0;
  const f = await fixture(t, {
    fetch: async () => {
      requests++;
      throw new Error('No network expected');
    },
    deepAgentsRunner: async () => {
      models++;
      throw new Error('No model expected');
    },
    deepAgentsAvailable: () => ({ configured: false, reason: 'Model credentials are missing.' }),
  });
  const capabilities = socialResearchCapabilitiesSchema.parse(
    await (await f.request('/research-runs/capabilities')).json(),
  );
  assert.equal(
    capabilities.harnesses.find((harness) => harness.id === 'deepagents')?.configured,
    false,
  );
  const response = await f.request('/research-runs', 'POST', input);
  assert.equal(response.status, 202);
  const started = socialResearchRunResponseSchema.parse(await response.json()).run;
  assert.equal(started.execution, 'demo_replay');
  const run = await f.poll(started.id);
  assert.equal(run.status, 'completed');
  assert.equal(requests, 0);
  assert.equal(models, 0);
  assert.deepEqual(
    new Set(run.events.map((event) => event.agent)),
    new Set(['coordinator', 'source_researcher', 'network_analyst', 'creative_strategist']),
  );
  assert.equal(run.artifacts.length, 5);
  assert.ok(run.events.some((event) => event.message.includes('synthetic')));
  const artifactResponse = await f.request(
    `/research-runs/${run.id}/artifacts?path=${encodeURIComponent('/research/sources.json')}`,
  );
  assert.equal(artifactResponse.status, 200);
  const { artifact } = socialResearchArtifactResponseSchema.parse(await artifactResponse.json());
  assert.equal(artifact.path, '/research/sources.json');
  assert.equal(artifact.truncated, false);
  assert.equal(artifact.bytes, Buffer.byteLength(artifact.content));
  const source = JSON.parse(artifact.content);
  assert.equal(source.posts.length, 8);
  assert.equal(source.posts[0].provider, 'demo');
  assert.ok(source.posts[0].collectedAt);
  for (const path of ['../../.env', 'C:\\secrets.env', '/research/chain-of-thought.md'])
    assert.equal(
      (await f.request(`/research-runs/${run.id}/artifacts?path=${encodeURIComponent(path)}`))
        .status,
      404,
    );
  const investigation = socialInvestigationResponseSchema.parse(
    await (await f.request(`/investigations/${run.investigationId}`)).json(),
  ).investigation;
  assert.equal(investigation.analysis.posts.length, 8);
  assert.equal(investigation.mode, 'demo');
});
test('live Deep Agents seam records actual tool calls while retaining the existing investigation envelope', async (t) => {
  let calls = 0;
  let models = 0;
  const f = await fixture(t, {
    config: { firecrawlApiKey: 'server-only-key' },
    deepAgentsAvailable: () => ({ configured: true, reason: 'Configured model and public tools.' }),
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                url: 'https://x.com/publiccreator/status/123',
                description: 'A public coffee experiment',
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
    deepAgentsRunner: async (context) => {
      models++;
      context.emit({
        agent: 'source_researcher',
        task: 'collect',
        phase: 'progress',
        message: 'Source research subagent invoked its public collection tool.',
      });
      const { harness: _harness, ...scope } = context.input;
      const dataset = await context.collect(scope, context.signal);
      context.writeArtifact(
        '/research/sources.json',
        JSON.stringify({ canonicalHarnessArtifact: true, postCount: dataset.posts.length }),
      );
      return dataset;
    },
  });
  const response = await f.request('/research-runs', 'POST', { ...input, mode: 'live' });
  assert.equal(response.status, 202);
  const started = socialResearchRunResponseSchema.parse(await response.json()).run;
  const run = await f.poll(started.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.execution, 'deepagents');
  assert.equal(models, 1);
  assert.equal(calls, 1);
  assert.ok(
    run.events.some((event) => event.provider === 'firecrawl' && event.phase === 'started'),
  );
  assert.doesNotMatch(JSON.stringify(run), /server-only-key|Authorization/);
  const canonical = socialResearchArtifactResponseSchema.parse(
    await (
      await f.request(
        `/research-runs/${run.id}/artifacts?path=${encodeURIComponent('/research/sources.json')}`,
      )
    ).json(),
  ).artifact;
  assert.equal(JSON.parse(canonical.content).canonicalHarnessArtifact, true);
  const { investigation } = socialInvestigationResponseSchema.parse(
    await (await f.request(`/investigations/${run.investigationId}`)).json(),
  );
  assert.equal(investigation.analysis.posts[0]?.provider, 'firecrawl');
});
test('unconfigured live harness refuses before launch and cancellation stops a replay before persistence', async (t) => {
  const f = await fixture(t, {
    demoStepDelayMs: 50,
    deepAgentsAvailable: () => ({ configured: false, reason: 'Configure model credentials.' }),
  });
  assert.equal((await f.request('/research-runs', 'POST', { ...input, mode: 'live' })).status, 503);
  const started = socialResearchRunResponseSchema.parse(
    await (await f.request('/research-runs', 'POST', input)).json(),
  ).run;
  const canceled = socialResearchRunResponseSchema.parse(
    await (await f.request(`/research-runs/${started.id}`, 'DELETE')).json(),
  ).run;
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.investigationId, null);
  assert.equal((await f.poll(started.id)).status, 'canceled');
  const list = await (await f.request('/investigations?summary=true')).json();
  assert.deepEqual(list.investigations, []);
});
test('background run deadlines are public and raw harness failures remain private', async (t) => {
  const f = await fixture(t, {
    config: { firecrawlApiKey: 'configured' },
    researchRunTimeoutMs: 15,
    deepAgentsAvailable: () => ({ configured: true, reason: 'Configured.' }),
    deepAgentsRunner: async () => new Promise(() => undefined),
  });
  const started = socialResearchRunResponseSchema.parse(
    await (await f.request('/research-runs', 'POST', { ...input, mode: 'live' })).json(),
  ).run;
  const run = await f.poll(started.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.error?.code, 'SOCIAL_RUN_TIMEOUT');
  assert.equal(run.investigationId, null);
});
