import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { creatorSessionResponseSchema, type CreatorSessionResponse } from '@yap/contracts/creator';
import { type Workflow, workflowResponseSchema } from '@yap/contracts/workflow';
import { createApp } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import {
  createWorkflowProvider,
  type VideoWorkflowProvider,
  type WorkflowScriptTiming,
} from '../src/workflow-provider.js';

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const versions = (value: CreatorSessionResponse) => ({
  expectedVersion: value.session.version,
  expectedWorkflowVersion: value.workflow.version,
});
const guided = createWorkflowProvider({ provider: 'guided' });

async function fixture(t: TestContext, provider: VideoWorkflowProvider, duration = 15) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-prepare-recovery-'));
  const dataFile = join(directory, 'projects.json');
  const open = async () => {
    const app = await createApp({
      dataFile,
      workflowProvider: provider,
      creatorOptions: {
        video: {
          configured: false,
          profile: {
            provider: 'fal',
            model: 'seedance-v1.5-pro',
            minSeconds: 4,
            maxSeconds: 10,
            rateCentsPerSecond: 5,
            priceSourceUrl: 'https://fal.ai',
            pricingCheckedAt: '2026-11-14',
          },
          generate: async () => {
            throw new Error('Video generation is forbidden in preparation tests.');
          },
          cancel: async () => {},
        },
        auditor: {
          configured: false,
          audit: async () => {
            throw new Error('Paid audit is forbidden in preparation tests.');
          },
        },
        analyze: async () => {
          throw new Error('Remote research is forbidden in preparation tests.');
        },
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return {
      base: `http://127.0.0.1:${address.port}/api`,
      close: async () => {
        await app.locals.shutdown();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    };
  };
  let running = await open();
  t.after(async () => {
    await running.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path: string, init?: RequestInit) => fetch(running.base + path, init);
  const created = await request(
    '/creator/sessions',
    json('POST', {
      input: {
        mode: 'text',
        prompt: 'A handmade ceramic cup.',
        urls: [],
        duration,
        platform: 'tiktok',
        tone: 'bold',
      },
    }),
  );
  assert.equal(created.status, 201);
  const initial = creatorSessionResponseSchema.parse(await created.json());
  const prefix = `/creator/sessions/${initial.session.id}`;
  const edited = await request(
    prefix,
    json('PATCH', {
      expectedVersion: initial.session.version,
      answers: [
        { questionId: 'productName', answer: 'Ceramic Cup' },
        { questionId: 'productDescription', answer: 'A handmade ceramic cup.' },
        { questionId: 'audience', answer: 'Tea lovers' },
        { questionId: 'keyBenefits', answer: 'Handmade' },
        { questionId: 'callToAction', answer: 'Visit our shop' },
      ],
    }),
  );
  assert.equal(edited.status, 200);
  return {
    directory,
    request,
    prefix,
    value: creatorSessionResponseSchema.parse(await edited.json()),
    load: async () => creatorSessionResponseSchema.parse(await (await request(prefix)).json()),
    prepare: (value: CreatorSessionResponse) =>
      request(prefix + '/prepare', json('POST', versions(value))),
    restart: async () => {
      await running.close();
      running = await open();
    },
  };
}

test('a saved short-hook script is not purchased again and can be edited before scene drafting', async (t) => {
  let scripts = 0,
    scenes = 0,
    timing: WorkflowScriptTiming | undefined;
  const f = await fixture(t, {
    ...guided,
    script: async (workflow, signal, limits) => {
      scripts++;
      timing = limits;
      const script = await guided.script(workflow, signal);
      return {
        ...script,
        segments: script.segments.map((segment, index) => ({
          ...segment,
          text: 'Ceramic cup detail.',
          seconds: [3, 6, 6][index]!,
        })),
      };
    },
    scenes: async (...args) => {
      scenes++;
      return guided.scenes(...args);
    },
  });
  const first = await f.prepare(f.value);
  assert.equal(first.status, 409);
  assert.equal((await first.json()).error.code, 'CREATOR_PREPARE_REVIEW_REQUIRED');
  assert.deepEqual(timing, { minSeconds: 4, maxSeconds: 10, maxSegments: 12 });
  const saved = await f.load();
  assert.ok(saved.workflow.script);
  assert.equal(saved.workflow.scenes, null);
  assert.equal(saved.session.plan, null);
  assert.equal(saved.session.approval, null);
  assert.deepEqual(
    saved.workflow.script.segments.map((segment) => segment.seconds),
    [3, 6, 6],
  );
  assert.equal((await f.prepare(saved)).status, 409);
  assert.equal(scripts, 1);
  assert.equal(scenes, 0);
  const edited = await f.request(
    `/workflows/${saved.workflow.id}/script`,
    json('PATCH', {
      expectedVersion: saved.workflow.version,
      hook: saved.workflow.script.hook,
      caption: saved.workflow.script.caption,
      segments: saved.workflow.script.segments.map((segment) => ({ ...segment, seconds: 5 })),
    }),
  );
  assert.equal(edited.status, 200, await edited.clone().text());
  const prepared = await f.prepare(await f.load());
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const result = creatorSessionResponseSchema.parse(await prepared.json());
  assert.ok(result.session.plan);
  assert.equal(result.session.approval, null);
  assert.equal(result.session.plan.workflowVersion, result.workflow.version);
  assert.equal(scripts, 1);
  assert.equal(scenes, 1);
});

test('scene-provider failure preserves the completed script across restart and retries only the missing stage', async (t) => {
  let scripts = 0,
    scenes = 0;
  const f = await fixture(t, {
    ...guided,
    script: async (...args) => {
      scripts++;
      return guided.script(...args);
    },
    scenes: async (...args) => {
      scenes++;
      if (scenes === 1) throw new ApiError(502, 'PROVIDER_UNAVAILABLE', 'Fixture failure.');
      return guided.scenes(...args);
    },
  });
  const failed = await f.prepare(f.value);
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).error.code, 'CREATOR_PREPARE_REVIEW_REQUIRED');
  const persisted = JSON.parse(await readFile(join(f.directory, 'workflows.json'), 'utf8'));
  assert.ok(persisted.workflows[0].script);
  assert.equal(persisted.workflows[0].scenes, null);
  await f.restart();
  assert.equal((await f.prepare(f.value)).status, 409, 'old workflow versions must not buy work');
  const saved = await f.load();
  const result = await f.prepare(saved);
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(scripts, 1);
  assert.equal(scenes, 2);
});

test('a plan-limit failure preserves both valid paid stages without dropping scenes or buying them again', async (t) => {
  let scripts = 0,
    scenes = 0;
  const f = await fixture(
    t,
    {
      ...guided,
      script: async (...args) => {
        scripts++;
        const script = await guided.script(...args);
        return {
          ...script,
          segments: Array.from({ length: 12 }, (_, index) => ({
            id: randomUUID(),
            text: `Keep detail ${index + 1}.`,
            seconds: index === 0 ? 16 : 4,
          })),
        };
      },
      scenes: async (...args) => {
        scenes++;
        return guided.scenes(...args);
      },
    },
    60,
  );
  const first = await f.prepare(f.value);
  assert.equal(first.status, 409);
  const failure = await first.json();
  assert.equal(failure.error.code, 'CREATOR_PREPARE_REVIEW_REQUIRED');
  assert.match(failure.error.message, /twelve short clips/);
  const saved = await f.load();
  assert.equal(saved.workflow.script?.segments.length, 12);
  assert.equal(saved.workflow.scenes?.scenes.length, 12);
  assert.equal(saved.session.plan, null);
  assert.equal((await f.prepare(saved)).status, 409);
  assert.equal(scripts, 1);
  assert.equal(scenes, 1);
});

test(
  'a concurrent workflow edit cannot be overwritten by a late scene checkpoint',
  { timeout: 15_000 },
  async (t) => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const f = await fixture(t, {
      ...guided,
      scenes: async (...args) => {
        entered();
        await gate;
        return guided.scenes(...args);
      },
    });
    const preparing = f.prepare(f.value);
    await started;
    const saved = await f.load();
    assert.ok(saved.workflow.script);
    const edited = await f.request(
      `/workflows/${saved.workflow.id}/script`,
      json('PATCH', {
        expectedVersion: saved.workflow.version,
        hook: 'A newly edited hook.',
        caption: saved.workflow.script.caption,
        segments: saved.workflow.script.segments,
      }),
    );
    assert.equal(edited.status, 200);
    const changed = workflowResponseSchema.parse(await edited.json());
    release();
    const response = await preparing;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'WORKFLOW_VERSION_CONFLICT');
    const latest = await f.load();
    assert.equal(latest.workflow.script?.id, changed.workflow.script?.id);
    assert.equal(latest.workflow.script?.hook, 'A newly edited hook.');
    assert.equal(latest.workflow.scenes, null);
    assert.equal(latest.session.approval, null);
  },
);

test('the real drafting adapter receives feasible selected-provider timing before its model call', async () => {
  let task = '';
  const provider = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-only', model: 'gpt-6-luna' },
    {
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        task = body.input[1].content[0].text;
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    hook: 'Ceramic cup.',
                    segments: [5, 5, 5].map((seconds) => ({ text: 'Ceramic cup.', seconds })),
                    caption: 'Visit our shop.',
                  }),
                },
              ],
            },
          ],
        });
      },
    },
  );
  const source: Workflow = {
    id: randomUUID(),
    version: 1,
    contentRevision: 1,
    title: 'Cup',
    input: 'A ceramic cup.',
    brief: {
      productName: 'Cup',
      productDescription: 'A ceramic cup.',
      audience: 'Tea lovers',
      keyBenefits: ['Handmade'],
      callToAction: 'Visit our shop.',
      imageDirection: '',
      platform: 'tiktok',
      tone: 'bold',
      duration: 15,
    },
    assets: [],
    messages: [],
    questions: [],
    script: null,
    scenes: null,
    approvals: { brief: null, script: null, scenes: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await provider.script(source, undefined, { minSeconds: 4, maxSeconds: 10, maxSegments: 12 });
  assert.match(task, /Use 2\.\.3 segments/);
  assert.match(task, /integer 4\.\.10 seconds/);
  assert.match(task, /total exactly 15 seconds/);
});
