import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { renderJobResponseSchema, type RenderJob } from '@yap/contracts/render';
import {
  workflowResponseSchema,
  workflowQueryResponseSchema,
  type Workflow,
} from '@yap/contracts/workflow';
import { createApp, type AppOptions } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import { createWorkflowProvider } from '../src/workflow-provider.js';
import type { PromoRenderer } from '../src/video-render-queue.js';

// This fixture tests transport, persistence, and render orchestration. The real encoder has separate tests.
const videoBytes = Buffer.from('00000018ftypisom-yap-transport-fixture');
const fixtureRenderer: PromoRenderer = async ({ workflow, outputPath, loadAsset }) => {
  for (const asset of workflow.assets) assert.ok((await loadAsset(asset)).length > 0);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, videoBytes);
  return {
    bytes: videoBytes.length,
    sha256: createHash('sha256').update(videoBytes).digest('hex'),
    width: 1080,
    height: 1920,
    duration: workflow.brief.duration!,
  };
};

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function fixture(t: TestContext, overrides: Partial<AppOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-workflow-api-'));
  const dataFile = join(directory, 'projects.json');
  const photos = join(directory, 'photos');
  const videos = join(directory, 'videos');
  let server: Server | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let base = '';
  async function stop() {
    await shutdown?.();
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
  }
  async function start() {
    const app = await createApp({
      dataFile,
      assetsDirectory: photos,
      rendersDirectory: videos,
      promoRenderer: fixtureRenderer,
      ...overrides,
    });
    shutdown = app.locals.shutdown;
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}/api/workflows`;
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    photos,
    videos,
    request(path: string, init?: RequestInit) {
      return fetch(base + path, init);
    },
    async restart() {
      await stop();
      await start();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json()).error.code, code);
}

async function readWorkflow(response: Response, status = 200): Promise<Workflow> {
  assert.equal(response.status, status, await response.clone().text());
  return workflowResponseSchema.parse(await response.json()).workflow;
}

async function create(f: Fixture): Promise<Workflow> {
  const response = await f.request(
    '',
    json('POST', {
      title: 'Moss matcha',
      input: 'Make a welcoming promo for our matcha shop using photos of our drinks and counter.',
      brief: { duration: 15 },
    }),
  );
  const workflow = await readWorkflow(response, 201);
  assert.equal(response.headers.get('location'), `/api/workflows/${workflow.id}`);
  return workflow;
}

async function png() {
  return sharp({ create: { width: 32, height: 48, channels: 3, background: '#72a36a' } })
    .png()
    .toBuffer();
}

async function upload(f: Fixture, workflow: Workflow): Promise<Workflow> {
  return readWorkflow(
    await f.request(`/${workflow.id}/assets?expectedVersion=${workflow.version}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'X-File-Name': encodeURIComponent('Iced matcha.png'),
      },
      body: await png(),
    }),
    201,
  );
}

async function prepare(f: Fixture, workflow: Workflow): Promise<Workflow> {
  return readWorkflow(
    await f.request(`/${workflow.id}/prepare`, json('POST', { expectedVersion: workflow.version })),
  );
}

async function approveAll(f: Fixture, workflow: Workflow): Promise<Workflow> {
  return readWorkflow(
    await f.request(
      `/${workflow.id}/approve-all`,
      json('POST', { expectedVersion: workflow.version }),
    ),
  );
}

async function awaitJob(f: Fixture, workflowId: string, jobId: string): Promise<RenderJob> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await f.request(`/${workflowId}/renders/${jobId}`);
    assert.equal(response.status, 200);
    const { job } = renderJobResponseSchema.parse(await response.json());
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await delay(10);
  }
  throw new Error('The test render did not reach a terminal state within five seconds.');
}

test('matcha shop input and photos become a reviewed promo, durable history, and a downloadable publish kit', async (t) => {
  const f = await fixture(t);
  let workflow = await create(f);
  assert.equal(workflow.version, 1);
  assert.equal(workflow.brief.duration, 15);
  workflow = await upload(f, workflow);
  assert.equal(workflow.assets[0]?.filename, 'Iced matcha.png');
  const photoResponse = await f.request(`/${workflow.id}/assets/${workflow.assets[0]!.id}`);
  assert.equal(photoResponse.status, 200);
  assert.match(photoResponse.headers.get('content-type') ?? '', /image\/png/);
  assert.equal(Buffer.from(await photoResponse.arrayBuffer()).length, workflow.assets[0]!.bytes);
  const beforeQuery = structuredClone(workflow);
  const query = await f.request(
    `/${workflow.id}/query`,
    json('POST', { question: 'What photos and details have we supplied?' }),
  );
  assert.equal(query.status, 200);
  assert.equal(
    workflowQueryResponseSchema.parse(await query.json()).workflowVersion,
    workflow.version,
  );
  assert.deepEqual(await readWorkflow(await f.request(`/${workflow.id}`)), beforeQuery);
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/refine`,
      json('POST', {
        expectedVersion: workflow.version,
        message: 'Make the focus our matcha drinks and a relaxed visit.',
        answers: {
          keyBenefits: 'Matcha drinks; A relaxed place to take a break',
          imageDirection: 'Start with a drink close view, then show the counter.',
        },
        brief: { callToAction: 'Visit Moss matcha this week.' },
      }),
    ),
  );
  workflow = await prepare(f, workflow);
  assert.deepEqual(workflow.approvals, { brief: null, script: null, scenes: null });
  assert.equal(
    workflow.script!.segments.reduce((sum, segment) => sum + segment.seconds, 0),
    15,
  );
  assert.equal(
    workflow.scenes!.scenes.reduce((sum, scene) => sum + scene.seconds, 0),
    15,
  );
  assert.ok(workflow.scenes!.scenes.every((scene) => scene.assetIds.length > 0));
  await expectError(
    await f.request(`/${workflow.id}/renders`, json('POST', { expectedVersion: workflow.version })),
    409,
    'PROMO_APPROVAL_REQUIRED',
  );
  workflow = await approveAll(f, workflow);
  const approvedVersion = workflow.version;
  const queued = await f.request(
    `/${workflow.id}/renders`,
    json('POST', { expectedVersion: workflow.version }),
  );
  assert.equal(queued.status, 202);
  const queuedJob = renderJobResponseSchema.parse(await queued.json()).job;
  assert.equal((await awaitJob(f, workflow.id, queuedJob.id)).status, 'succeeded');
  assert.equal((await readWorkflow(await f.request(`/${workflow.id}`))).version, approvedVersion);
  await f.restart();
  const restarted = await readWorkflow(await f.request(`/${workflow.id}`));
  assert.deepEqual(restarted, workflow);
  const history = await (await f.request(`/${workflow.id}/history`)).json();
  assert.deepEqual(
    history.history.map((item: Workflow) => item.version),
    [5, 4, 3, 2, 1],
  );
  assert.equal(history.history.at(-1).assets.length, 0);
  const publish = await f.request(`/${workflow.id}/publish`);
  assert.equal(publish.status, 200);
  const kit = await publish.json();
  assert.equal(kit.ready, true);
  assert.equal(kit.automaticPosting, false);
  assert.equal(kit.video.hasAudio, false);
  assert.equal(kit.caption, workflow.script!.caption);
  const downloaded = await f.request(`/${workflow.id}/renders/${queuedJob.id}/video?download=1`);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-type') ?? '', /video\/mp4/);
  assert.match(downloaded.headers.get('content-disposition') ?? '', /\.mp4/);
  assert.equal(downloaded.headers.get('x-yap-source-stale'), 'false');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), videoBytes);
  const search = await (await f.request('?q=Moss')).json();
  assert.deepEqual(
    search.workflows.map((item: Workflow) => item.id),
    [workflow.id],
  );
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/refine`,
      json('POST', {
        expectedVersion: workflow.version,
        brief: { callToAction: 'Come by for an afternoon break.' },
      }),
    ),
  );
  assert.equal(workflow.script, null);
  assert.equal(workflow.scenes, null);
  assert.deepEqual(workflow.approvals, { brief: null, script: null, scenes: null });
  await expectError(await f.request(`/${workflow.id}/publish`), 409, 'PROMO_APPROVAL_REQUIRED');
  const previousDownload = await f.request(`/${workflow.id}/renders/${queuedJob.id}/video`);
  assert.equal(previousDownload.headers.get('x-yap-source-stale'), 'true');
});

test('invalid and cross-workflow photos are rejected without committing metadata', async (t) => {
  const f = await fixture(t);
  let first = await create(f);
  const second = await create(f);
  await expectError(
    await f.request(`/${first.id}/assets?expectedVersion=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from('not an image'),
    }),
    400,
    'INVALID_IMAGE',
  );
  await expectError(
    await f.request(`/${first.id}/assets?expectedVersion=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: await png(),
    }),
    415,
    'IMAGE_TYPE_MISMATCH',
  );
  await expectError(
    await f.request(`/${first.id}/assets?expectedVersion=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('../photo.png') },
      body: await png(),
    }),
    400,
    'INVALID_IMAGE_METADATA',
  );
  assert.equal((await readWorkflow(await f.request(`/${first.id}`))).version, 1);
  first = await upload(f, first);
  const assetId = first.assets[0]!.id;
  await expectError(await f.request(`/${second.id}/assets/${assetId}`), 404, 'ASSET_NOT_FOUND');
  await expectError(
    await f.request(
      `/${second.id}/assets/${assetId}`,
      json('PATCH', { expectedVersion: second.version, description: 'Not this workflow’s image.' }),
    ),
    404,
    'ASSET_NOT_FOUND',
  );
  await expectError(
    await f.request(`/${first.id}/assets?expectedVersion=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: await png(),
    }),
    409,
    'WORKFLOW_VERSION_CONFLICT',
  );
  assert.equal((await readWorkflow(await f.request(`/${second.id}`))).version, 1);
});

test('concurrent uploads using one version retain only the committed photo file', async (t) => {
  const f = await fixture(t);
  const workflow = await create(f);
  const bytes = await png();
  const results = await Promise.all(
    [0, 1].map(() =>
      f.request(`/${workflow.id}/assets?expectedVersion=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: bytes,
      }),
    ),
  );
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const current = await readWorkflow(await f.request(`/${workflow.id}`));
  assert.equal(current.version, 2);
  assert.equal(current.assets.length, 1);
  assert.equal((await readdir(join(f.photos, workflow.id))).length, 1);
});

test('individual stage endpoints enforce approvals and reject timing drift without advancing the version', async (t) => {
  const f = await fixture(t);
  let workflow = await create(f);
  await expectError(
    await f.request(
      `/${workflow.id}/script/generate`,
      json('POST', { expectedVersion: workflow.version }),
    ),
    409,
    'APPROVAL_REQUIRED',
  );
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/approve`,
      json('POST', { expectedVersion: workflow.version, stage: 'brief' }),
    ),
  );
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/script/generate`,
      json('POST', { expectedVersion: workflow.version }),
    ),
  );
  const script = workflow.script!;
  await expectError(
    await f.request(
      `/${workflow.id}/script`,
      json('PATCH', {
        expectedVersion: workflow.version,
        hook: script.hook,
        caption: script.caption,
        segments: script.segments.map((segment, index) => ({
          ...segment,
          seconds: segment.seconds + (index === 0 ? 1 : 0),
        })),
      }),
    ),
    400,
    'WORKFLOW_VERIFICATION_FAILED',
  );
  assert.equal((await readWorkflow(await f.request(`/${workflow.id}`))).version, workflow.version);
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/approve`,
      json('POST', { expectedVersion: workflow.version, stage: 'script' }),
    ),
  );
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/scenes/generate`,
      json('POST', { expectedVersion: workflow.version }),
    ),
  );
  await expectError(
    await f.request(
      `/${workflow.id}/scenes`,
      json('PATCH', {
        expectedVersion: workflow.version,
        scenes: workflow.scenes!.scenes.map((scene, index) => ({
          ...scene,
          seconds: scene.seconds + (index === 0 ? 1 : 0),
        })),
      }),
    ),
    400,
    'WORKFLOW_VERIFICATION_FAILED',
  );
  assert.equal((await readWorkflow(await f.request(`/${workflow.id}`))).version, workflow.version);
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/script`,
      json('PATCH', {
        expectedVersion: workflow.version,
        hook: 'Take a break with Moss.',
        caption: script.caption,
        segments: script.segments,
      }),
    ),
  );
  assert.equal(workflow.approvals.script, null);
  assert.equal(workflow.scenes, null);
  await expectError(
    await f.request(
      `/${workflow.id}/scenes/generate`,
      json('POST', { expectedVersion: workflow.version }),
    ),
    409,
    'APPROVAL_REQUIRED',
  );
});

test('provider failures leave the workflow, approvals, and revision history unchanged', async (t) => {
  const guided = createWorkflowProvider({ provider: 'guided' });
  const f = await fixture(t, {
    workflowProvider: {
      ...guided,
      async script() {
        throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'The test provider is unavailable.');
      },
    },
  });
  const workflow = await create(f);
  await expectError(
    await f.request(`/${workflow.id}/prepare`, json('POST', { expectedVersion: workflow.version })),
    503,
    'PROVIDER_UNAVAILABLE',
  );
  assert.deepEqual(await readWorkflow(await f.request(`/${workflow.id}`)), workflow);
  assert.equal((await (await f.request(`/${workflow.id}/history`)).json()).history.length, 1);
});

test('explicit refinement answers take precedence over contradictory provider suggestions', async (t) => {
  const guided = createWorkflowProvider({ provider: 'guided' });
  const f = await fixture(t, {
    workflowProvider: {
      ...guided,
      async refine() {
        return {
          brief: {
            productName: 'Invented brand',
            keyBenefits: ['Invented benefit'],
            audience: 'Everyone in the world',
          },
          message: 'A suggested refinement.',
        };
      },
    },
  });
  const workflow = await create(f);
  const updated = await readWorkflow(
    await f.request(
      `/${workflow.id}/refine`,
      json('POST', {
        expectedVersion: workflow.version,
        answers: { productName: 'Moss matcha', keyBenefits: 'A quiet visit; Matcha drinks' },
        brief: { audience: 'Local matcha fans' },
      }),
    ),
  );
  assert.equal(updated.brief.productName, 'Moss matcha');
  assert.deepEqual(updated.brief.keyBenefits, ['A quiet visit', 'Matcha drinks']);
  assert.equal(updated.brief.audience, 'Local matcha fans');
});

test('a slow preparation cannot overwrite a newer creator refinement', async (t) => {
  const guided = createWorkflowProvider({ provider: 'guided' });
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    workflowProvider: {
      ...guided,
      async script(workflow) {
        enter();
        await wait;
        return guided.script(workflow);
      },
    },
  });
  const workflow = await create(f);
  const pending = f.request(
    `/${workflow.id}/prepare`,
    json('POST', { expectedVersion: workflow.version }),
  );
  await entered;
  let refined: Workflow;
  try {
    refined = await readWorkflow(
      await f.request(
        `/${workflow.id}/refine`,
        json('POST', {
          expectedVersion: workflow.version,
          brief: { callToAction: 'Bring a friend to Moss.' },
        }),
      ),
    );
  } finally {
    release();
  }
  await expectError(await pending, 409, 'WORKFLOW_VERSION_CONFLICT');
  const current = await readWorkflow(await f.request(`/${workflow.id}`));
  assert.equal(current.version, refined!.version);
  assert.equal(current.brief.callToAction, 'Bring a friend to Moss.');
  assert.equal(current.script, null);
});

test('render failures persist an actionable job receipt without altering the reviewed workflow', async (t) => {
  const f = await fixture(t, {
    promoRenderer: async () => {
      throw new ApiError(503, 'ENCODER_UNAVAILABLE', 'The test encoder is unavailable.');
    },
  });
  let workflow = await upload(f, await create(f));
  workflow = await approveAll(f, await prepare(f, workflow));
  const response = await f.request(
    `/${workflow.id}/renders`,
    json('POST', { expectedVersion: workflow.version }),
  );
  assert.equal(response.status, 202);
  const queued = renderJobResponseSchema.parse(await response.json()).job;
  const failed = await awaitJob(f, workflow.id, queued.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'ENCODER_UNAVAILABLE');
  assert.equal(failed.output, null);
  assert.deepEqual(await readWorkflow(await f.request(`/${workflow.id}`)), workflow);
  await expectError(
    await f.request(`/${workflow.id}/renders/${failed.id}/video`),
    409,
    'VIDEO_NOT_READY',
  );
  await f.restart();
  assert.equal(
    renderJobResponseSchema.parse(
      await (await f.request(`/${workflow.id}/renders/${failed.id}`)).json(),
    ).job.status,
    'failed',
  );
});

test('rendering requires photos even when a text-only plan was approved', async (t) => {
  const f = await fixture(t);
  const workflow = await approveAll(f, await prepare(f, await create(f)));
  await expectError(
    await f.request(`/${workflow.id}/renders`, json('POST', { expectedVersion: workflow.version })),
    409,
    'RENDER_PHOTOS_REQUIRED',
  );
});

test('active renders retain their photos and fail cleanly if the creator changes the source', async (t) => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    promoRenderer: async (options) => {
      enter();
      await waiting;
      return fixtureRenderer(options);
    },
  });
  let workflow = await upload(f, await create(f));
  workflow = await approveAll(f, await prepare(f, workflow));
  const response = await f.request(
    `/${workflow.id}/renders`,
    json('POST', { expectedVersion: workflow.version }),
  );
  assert.equal(response.status, 202);
  const { job } = renderJobResponseSchema.parse(await response.json());
  await entered;
  try {
    await expectError(
      await f.request(
        `/${workflow.id}/assets/${workflow.assets[0]!.id}?expectedVersion=${workflow.version}`,
        { method: 'DELETE' },
      ),
      409,
      'RENDER_IN_PROGRESS',
    );
    await expectError(
      await f.request(`/${workflow.id}?expectedVersion=${workflow.version}`, { method: 'DELETE' }),
      409,
      'RENDER_IN_PROGRESS',
    );
    workflow = await readWorkflow(
      await f.request(
        `/${workflow.id}/refine`,
        json('POST', {
          expectedVersion: workflow.version,
          brief: { callToAction: 'Bring a friend to our shop.' },
        }),
      ),
    );
  } finally {
    release();
  }
  const failed = await awaitJob(f, workflow.id, job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'RENDER_SOURCE_CHANGED');
  assert.equal(failed.output, null);
  assert.equal((await readdir(f.videos)).length, 0);
  assert.equal((await f.request(`/${workflow.id}/assets/${workflow.assets[0]!.id}`)).status, 200);
});

test('a same-length modification to a rendered video blocks both its download and publish kit', async (t) => {
  const f = await fixture(t);
  let workflow = await upload(f, await create(f));
  workflow = await approveAll(f, await prepare(f, workflow));
  const response = await f.request(
    `/${workflow.id}/renders`,
    json('POST', { expectedVersion: workflow.version }),
  );
  assert.equal(response.status, 202);
  const { job } = renderJobResponseSchema.parse(await response.json());
  assert.equal((await awaitJob(f, workflow.id, job.id)).status, 'succeeded');
  assert.equal((await f.request(`/${workflow.id}/publish`)).status, 200);
  assert.equal((await f.request(`/${workflow.id}/renders/${job.id}/video`)).status, 200);
  const tampered = Buffer.from(videoBytes);
  tampered[0] = tampered[0]! ^ 1;
  assert.equal(tampered.length, videoBytes.length);
  await writeFile(join(f.videos, `${job.id}.mp4`), tampered);
  for (const path of [`/${workflow.id}/renders/${job.id}/video`, `/${workflow.id}/publish`]) {
    const failed = await f.request(path);
    assert.equal(failed.status, 500);
    const body = await failed.json();
    assert.equal(body.error.code, 'VIDEO_FILE_CORRUPTED');
    assert.equal(typeof body.error.message, 'string');
    assert.notEqual(body.ready, true);
  }
});

test('a creator can edit a proposed script and scene plan before approving the promo', async (t) => {
  const f = await fixture(t);
  let workflow = await prepare(f, await upload(f, await create(f)));
  const script = workflow.script!;
  const initialScriptId = script.id;
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/script`,
      json('PATCH', {
        expectedVersion: workflow.version,
        hook: 'Your next little matcha break.',
        caption: script.caption,
        segments: script.segments.map((segment, index) =>
          index === 0 ? { ...segment, text: 'Your next little matcha break.' } : segment,
        ),
      }),
    ),
  );
  assert.notEqual(workflow.script!.id, initialScriptId);
  assert.equal(workflow.scenes, null);
  assert.deepEqual(workflow.approvals, { brief: null, script: null, scenes: null });
  await expectError(
    await f.request(
      `/${workflow.id}/scenes/generate`,
      json('POST', { expectedVersion: workflow.version }),
    ),
    409,
    'APPROVAL_REQUIRED',
  );
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/scenes/prepare`,
      json('POST', { expectedVersion: workflow.version }),
    ),
  );
  assert.equal(workflow.scenes!.sourceScriptId, workflow.script!.id);
  const scenesId = workflow.scenes!.id;
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/scenes`,
      json('PATCH', {
        expectedVersion: workflow.version,
        scenes: workflow.scenes!.scenes.map((scene, index) =>
          index === 0
            ? {
                ...scene,
                visual: 'Start with the supplied drink photo.',
                onScreenText: 'A little matcha moment',
              }
            : scene,
        ),
      }),
    ),
  );
  assert.notEqual(workflow.scenes!.id, scenesId);
  assert.deepEqual(workflow.approvals, { brief: null, script: null, scenes: null });
  assert.equal(workflow.script!.hook, 'Your next little matcha break.');
  await expectError(
    await f.request(`/${workflow.id}/renders`, json('POST', { expectedVersion: workflow.version })),
    409,
    'PROMO_APPROVAL_REQUIRED',
  );
  workflow = await approveAll(f, workflow);
  const verification = (await (await f.request(`/${workflow.id}/verification`)).json())
    .verification;
  assert.deepEqual(
    Object.values(verification).map((stage: unknown) => (stage as { state: string }).state),
    ['approved', 'approved', 'approved'],
  );
});

test('preparing again preserves creator edits until regeneration is explicitly requested', async (t) => {
  const f = await fixture(t);
  let workflow = await prepare(f, await create(f));
  const script = workflow.script!;
  workflow = await readWorkflow(
    await f.request(
      `/${workflow.id}/script`,
      json('PATCH', {
        expectedVersion: workflow.version,
        hook: 'Make some time for matcha.',
        caption: 'A caption written by the shop owner.',
        segments: script.segments.map((segment, index) =>
          index === 0 ? { ...segment, text: 'Make some time for matcha.' } : segment,
        ),
      }),
    ),
  );
  const editedScript = structuredClone(workflow.script);
  assert.equal(workflow.scenes, null);
  workflow = await prepare(f, workflow);
  assert.deepEqual(workflow.script, editedScript);
  assert.equal(workflow.scenes!.sourceScriptId, workflow.script!.id);
  const prepared = structuredClone(workflow);
  workflow = await prepare(f, workflow);
  assert.deepEqual(workflow, prepared);
  const regenerated = await readWorkflow(
    await f.request(
      `/${workflow.id}/prepare`,
      json('POST', {
        expectedVersion: workflow.version,
        regenerate: true,
      }),
    ),
  );
  assert.notEqual(regenerated.script!.id, editedScript!.id);
  assert.notEqual(regenerated.scenes!.id, prepared.scenes!.id);
  assert.equal(regenerated.version, workflow.version + 1);
  assert.deepEqual(regenerated.approvals, { brief: null, script: null, scenes: null });
});
