import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import type { RenderJob } from '@yap/contracts/render';
import type { Workflow } from '@yap/contracts/workflow';
import { ApiError, StorageError } from '../src/errors.js';
import { WorkflowAssetStore } from '../src/workflow-assets.js';
import {
  approveAllWorkflow,
  buildGuidedScenes,
  buildGuidedScript,
  createWorkflow,
  setWorkflowScenes,
  setWorkflowScript,
} from '../src/workflow-engine.js';
import { WorkflowRepository } from '../src/workflow-repository.js';
import { VideoRenderQueue, type PromoRenderer } from '../src/video-render-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-workflow-storage-'));
  const file = join(directory, 'workflows.json');
  const videos = join(directory, 'videos');
  const assets = new WorkflowAssetStore(join(directory, 'photos'));
  const repository = await WorkflowRepository.open(file);
  const queues: VideoRenderQueue[] = [];
  t.after(async () => {
    for (const queue of queues) await queue.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    file,
    videos,
    assets,
    repository,
    queue(store: WorkflowRepository, renderer: PromoRenderer) {
      const queue = new VideoRenderQueue(store, assets, videos, renderer);
      queues.push(queue);
      return queue;
    },
    async workflow() {
      let workflow = createWorkflow({
        input: 'Introduce our local matcha shop using the supplied product photo.',
        brief: {
          productName: 'Moss Matcha',
          productDescription: 'A neighborhood matcha shop.',
          audience: 'Neighbors looking for their next morning drink.',
          keyBenefits: ['Freshly prepared matcha'],
          callToAction: 'Visit Moss Matcha today.',
          imageDirection: 'Keep the product photo visible and highlight the matcha drink.',
          duration: 15,
        },
      });
      const photo = await sharp({
        create: { width: 8, height: 12, channels: 3, background: '#72a36a' },
      })
        .png()
        .toBuffer();
      workflow.assets.push(await assets.upload(workflow.id, photo, 'image/png', 'matcha.png'));
      const preparation = { requireApproval: false };
      workflow = setWorkflowScript(workflow, buildGuidedScript(workflow, preparation), preparation);
      workflow = setWorkflowScenes(workflow, buildGuidedScenes(workflow, preparation), preparation);
      return repository.create(approveAllWorkflow(workflow));
    },
  };
}

function receipt(workflow: Workflow): RenderJob {
  assert.ok(workflow.scenes);
  return {
    id: randomUUID(),
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    sourceScenesId: workflow.scenes.id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    width: 1080,
    height: 1920,
    duration: workflow.brief.duration!,
    output: null,
    error: null,
  };
}

async function missing(path: string) {
  await assert.rejects(
    stat(path),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
  );
}

test('restart fails interrupted receipts and removes only their scoped render files and workspaces', async (t) => {
  const f = await fixture(t);
  const workflows = await Promise.all([f.workflow(), f.workflow()]);
  const jobs = workflows.map(receipt);
  await f.repository.createRender(jobs[0]!, workflows[0]!.version);
  await f.repository.createRender(jobs[1]!, workflows[1]!.version);
  await f.repository.updateRender(jobs[1]!.workflowId, jobs[1]!.id, (job) => ({
    ...job,
    status: 'running',
    startedAt: new Date().toISOString(),
  }));
  await mkdir(f.videos, { recursive: true });
  for (const job of jobs) {
    const workspace = join(f.videos, `.${job.id}.work`);
    await mkdir(workspace);
    await writeFile(join(workspace, 'private-photo-frame.png'), 'Incomplete photo frame.');
    await writeFile(join(f.videos, `${job.id}.mp4`), 'Incomplete MP4 output.');
  }
  const unrelatedId = randomUUID();
  const unrelatedWorkspace = join(f.videos, `.${unrelatedId}.work`);
  const unrelatedVideo = join(f.videos, `${unrelatedId}.mp4`);
  await mkdir(unrelatedWorkspace);
  await writeFile(join(unrelatedWorkspace, 'keep.txt'), 'A different job owns this workspace.');
  await writeFile(unrelatedVideo, 'A different job owns this video.');

  const restarted = await WorkflowRepository.open(f.file);
  for (const job of jobs) {
    const recovered = await restarted.render(job.workflowId, job.id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error?.code, 'RENDER_INTERRUPTED');
    assert.ok(recovered.completedAt);
    assert.equal(recovered.output, null);
  }
  let rendererCalls = 0;
  const queue = f.queue(restarted, async () => {
    rendererCalls += 1;
    throw new Error('Startup recovery must not run an interrupted job.');
  });
  await queue.recoverInterrupted();
  await queue.recoverInterrupted();
  for (const job of jobs) {
    await missing(join(f.videos, `.${job.id}.work`));
    await missing(join(f.videos, `${job.id}.mp4`));
  }
  assert.deepEqual(await readdir(unrelatedWorkspace), ['keep.txt']);
  assert.equal(
    await readFile(join(unrelatedWorkspace, 'keep.txt'), 'utf8'),
    'A different job owns this workspace.',
  );
  assert.equal(await readFile(unrelatedVideo, 'utf8'), 'A different job owns this video.');
  assert.equal(rendererCalls, 0);
  const persistedAgain = await WorkflowRepository.open(f.file);
  assert.equal((await persistedAgain.interruptedRenders()).length, 2);
});

test(
  'shutdown winning an in-flight enqueue leaves a durable failed receipt instead of stranded queued work',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const workflow = await f.workflow();
    const entered = deferred(),
      release = deferred();
    const commitRender = f.repository.createRender.bind(f.repository);
    f.repository.createRender = async (job, expectedVersion) => {
      entered.resolve();
      await release.promise;
      return commitRender(job, expectedVersion);
    };
    let rendererCalls = 0;
    const queue = f.queue(f.repository, async () => {
      rendererCalls += 1;
      throw new Error('A render must not start after shutdown won the enqueue race.');
    });
    const enqueueResult = assert.rejects(
      queue.enqueue(workflow, workflow.version),
      (error: unknown) =>
        error instanceof ApiError && error.status === 503 && error.code === 'RENDER_UNAVAILABLE',
    );
    try {
      await entered.promise;
      await queue.close();
    } finally {
      release.resolve();
    }
    await enqueueResult;
    const jobs = await f.repository.renders(workflow.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, 'failed');
    assert.equal(jobs[0]!.error?.code, 'RENDER_INTERRUPTED');
    assert.equal(jobs[0]!.startedAt, null);
    assert.ok(jobs[0]!.completedAt);
    assert.equal(rendererCalls, 0);
    const restarted = await WorkflowRepository.open(f.file);
    assert.deepEqual(await restarted.render(workflow.id, jobs[0]!.id), jobs[0]);
  },
);

test('malformed or schema-invalid existing workflow storage fails startup without replacing the data', async (t) => {
  const f = await fixture(t);
  for (const contents of [
    '{broken JSON',
    JSON.stringify({
      schemaVersion: 1,
      workflows: [],
      history: {},
      renders: [{ status: 'running' }],
    }),
  ]) {
    await writeFile(f.file, contents, 'utf8');
    await assert.rejects(
      WorkflowRepository.open(f.file),
      (error: unknown) =>
        error instanceof StorageError && /Restore a valid workflow data file/.test(error.message),
    );
    assert.equal(await readFile(f.file, 'utf8'), contents);
  }
});

test('concurrent updates using one expected version commit once and preserve the winning version after restart', async (t) => {
  const f = await fixture(t);
  const workflow = await f.workflow();
  const results = await Promise.allSettled(
    ['Morning matcha', 'Afternoon matcha'].map((title) =>
      f.repository.update(workflow.id, workflow.version, (current) => ({ ...current, title })),
    ),
  );
  const committed = results.filter((result) => result.status === 'fulfilled');
  const conflicts = results.filter((result) => result.status === 'rejected');
  assert.equal(committed.length, 1);
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0]!.status === 'rejected' && conflicts[0]!.reason instanceof ApiError);
  assert.equal(conflicts[0]!.reason.code, 'WORKFLOW_VERSION_CONFLICT');
  assert.equal(conflicts[0]!.reason.status, 409);
  assert.ok(committed[0]!.status === 'fulfilled');
  const winner = committed[0]!.value;
  assert.equal(winner.version, workflow.version + 1);
  const restarted = await WorkflowRepository.open(f.file);
  assert.deepEqual(await restarted.get(workflow.id), winner);
  const history = await restarted.history(workflow.id);
  assert.deepEqual(
    history.map((entry) => entry.version),
    [winner.version, workflow.version],
  );
  assert.equal(history[0]!.title, winner.title);
});
