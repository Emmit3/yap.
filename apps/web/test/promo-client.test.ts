import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { SocialHandoff } from '@yap/contracts/social';
import { createApp } from '../../api/src/app.js';
import type { PromoRenderer } from '../../api/src/video-render-queue.js';
import { createPromoApi } from '../src/promo/api.js';

// The workflow/client seam uses real HTTP, decoded product photos, and temporary
// persistence. Encoding itself has a separate real-FFmpeg integration test in API.
const videoBytes = Buffer.from('00000018ftypisom-yap-client-transport-fixture');

const transportRenderer: PromoRenderer = async ({ workflow, outputPath, loadAsset }) => {
  for (const scene of workflow.scenes!.scenes) {
    for (const id of scene.assetIds) {
      const asset = workflow.assets.find((candidate) => candidate.id === id);
      assert.ok(asset, 'the reviewed scene references an uploaded photo');
      assert.ok((await loadAsset(asset)).length > 0, 'the render can load the actual photo');
    }
  }
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

async function fixture(t: TestContext, renderer: PromoRenderer = transportRenderer) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-promo-client-'));
  const errors: unknown[] = [];
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    workflowDataFile: join(directory, 'workflows.json'),
    assetsDirectory: join(directory, 'photos'),
    rendersDirectory: join(directory, 'renders'),
    workflowProviderConfig: { provider: 'guided' },
    promoRenderer: renderer,
    onError: (error) => errors.push(error),
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const cleanupTarget = resolve(directory);
    assert.ok(
      cleanupTarget.startsWith(resolve(tmpdir()) + sep) &&
        basename(cleanupTarget).startsWith('yap-promo-client-'),
    );
    await rm(cleanupTarget, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'the public API should not encounter internal errors');
  });
  return { api: createPromoApi(origin), origin };
}

function isApiError(status: number, code?: string) {
  return (error: unknown) =>
    error instanceof Error &&
    'status' in error &&
    error.status === status &&
    (code === undefined || ('code' in error && error.code === code));
}

test('reviewed research keeps its evidence separate from the creator’s own product facts', async (t) => {
  const { api } = await fixture(t);
  const research: SocialHandoff = {
    investigationId: '2d064fcc-cb86-4973-8305-97fb95be21ce',
    topic: 'Question openings in neighborhood cafe promos',
    audience: 'People interested in cafe videos',
    creativeDirection: 'Adopt: Open with a short question, then show the creator’s own product.',
    selectedNoteIds: ['12e0edf2-27f0-4df7-994a-9dcb349e35d3'],
    selectedInsightIds: ['question-first'],
    evidence: [
      {
        postId: 'imported-cafe-reference',
        url: 'https://example.com/cafe-reference',
        excerpt: 'Reference Cafe advertises a 90 percent discount. This is their claim, not ours.',
        collectedAt: '2026-11-13T15:00:00.000Z',
        publishedAt: '2026-11-11T09:30:00.000Z',
        provider: 'import',
        contentKind: 'post',
      },
    ],
    sourceUrls: ['https://example.com/cafe-reference'],
    cautions: [
      'A small reference sample cannot establish why a post received attention.',
      'Do not copy the reference cafe’s discount or treat its claims as verified product facts.',
    ],
  };
  const input = 'Introduce our matcha drinks and invite neighbors to visit Mori on Sunday.';
  const brief = {
    productName: 'Mori Matcha',
    productDescription: 'A neighborhood matcha bar serving iced matcha.',
    audience: 'Neighbors meeting friends on Sunday',
    keyBenefits: ['Freshly whisked matcha', 'A place to meet friends'],
    callToAction: 'Visit Mori Matcha this Sunday.',
    imageDirection: 'Show only our supplied shop and drink photos.',
    platform: 'instagram' as const,
    tone: 'conversational' as const,
    duration: 15 as const,
  };
  let state = await api.create({ input, brief, research });
  assert.deepEqual(
    state.workflow.research,
    research,
    'source URLs, evidence dates, provenance, chosen direction, and cautions survive creation',
  );
  assert.equal(state.workflow.input, input);
  assert.deepEqual(
    state.workflow.brief,
    brief,
    'creative research does not replace the creator’s facts or audience',
  );
  assert.equal(state.workflow.script, null);
  assert.equal(state.workflow.scenes, null);
  assert.deepEqual(state.workflow.approvals, { brief: null, script: null, scenes: null });
  assert.deepEqual(await api.getRenders(state.workflow.id), []);

  state = await api.prepare(state.workflow.id, { expectedVersion: state.workflow.version });
  assert.deepEqual(state.workflow.brief, brief);
  assert.deepEqual(state.workflow.research, research);
  assert.doesNotMatch(
    JSON.stringify(state.workflow.script),
    /90 percent|Reference Cafe|discount/,
    'external product claims remain evidence, not promotional copy for the creator',
  );
  assert.deepEqual(state.workflow.approvals, { brief: null, script: null, scenes: null });
  assert.deepEqual(
    await api.getRenders(state.workflow.id),
    [],
    'neither research handoff nor proposal preparation approves or starts a render',
  );
  const reopened = await api.get(state.workflow.id);
  assert.deepEqual(reopened.workflow.research, research);
  assert.deepEqual(reopened.workflow.brief, brief);
  assert.equal(reopened.workflow.input, input);
});

test(
  'the frontend client carries real photos through review, explicit approval, render, and publish',
  { timeout: 30_000 },
  async (t) => {
    const { api, origin } = await fixture(t);
    let state = await api.create({
      title: 'Mori weekend promo',
      input:
        'Make a welcoming promo for our neighborhood matcha bar using our supplied drink photos.',
      brief: {
        productName: 'Mori Matcha',
        productDescription: 'A neighborhood matcha bar serving iced matcha and strawberry matcha.',
        audience: 'Neighbors looking for an afternoon drink',
        keyBenefits: ['Freshly whisked matcha', 'A place to meet friends'],
        callToAction: 'Visit Mori Matcha this weekend.',
        imageDirection: 'Feature the actual supplied drink photos without inventing a product.',
        platform: 'instagram',
        duration: 15,
        tone: 'conversational',
      },
    });
    const workflowId = state.workflow.id;
    const jpeg = await readFile(
      new URL('../../../public/media/wall-beverage.jpg', import.meta.url),
    );
    state = await api.upload(
      workflowId,
      state.workflow.version,
      new File([jpeg], 'Our iced drink.jpg', { type: 'image/jpeg' }),
    );
    const firstPhoto = state.workflow.assets[0]!;
    assert.equal(firstPhoto.filename, 'Our iced drink.jpg');
    assert.ok(firstPhoto.width > 1 && firstPhoto.height > 1);
    const photoResponse = await fetch(api.assetUrl(workflowId, firstPhoto.id));
    assert.equal(photoResponse.status, 200);
    assert.deepEqual(Buffer.from(await photoResponse.arrayBuffer()), jpeg);
    state = await api.describeAsset(
      workflowId,
      firstPhoto.id,
      state.workflow.version,
      'Our iced drink, served at the shop counter.',
    );
    assert.equal(
      state.workflow.assets[0]!.description,
      'Our iced drink, served at the shop counter.',
    );

    state = await api.prepare(workflowId, { expectedVersion: state.workflow.version });
    assert.deepEqual(
      state.workflow.approvals,
      { brief: null, script: null, scenes: null },
      'preparation proposes creative material without approving it',
    );
    assert.ok(state.workflow.script && state.workflow.scenes);
    await assert.rejects(
      api.render(workflowId, state.workflow.version),
      isApiError(409, 'PROMO_APPROVAL_REQUIRED'),
    );

    const script = state.workflow.script!;
    state = await api.updateScript(workflowId, {
      expectedVersion: state.workflow.version,
      hook: 'An afternoon worth slowing down for.',
      segments: script.segments,
      caption: 'A little matcha, a little time together. Visit Mori this weekend.',
    });
    assert.equal(state.workflow.scenes, null, 'editing the script invalidates the old scene plan');
    const editedScriptId = state.workflow.script!.id;
    state = await api.prepare(workflowId, { expectedVersion: state.workflow.version });
    assert.equal(
      state.workflow.script!.id,
      editedScriptId,
      'prepare preserves the creator’s edited script',
    );
    assert.equal(state.workflow.scenes!.sourceScriptId, editedScriptId);
    state = await api.updateScenes(workflowId, {
      expectedVersion: state.workflow.version,
      scenes: state.workflow.scenes!.scenes.map((scene, index) =>
        index === 0
          ? { ...scene, onScreenText: 'Your afternoon starts here.', assetIds: [firstPhoto.id] }
          : scene,
      ),
    });
    assert.equal(state.workflow.scenes!.scenes[0]!.onScreenText, 'Your afternoon starts here.');

    const staleReviewVersion = state.workflow.version;
    state = await api.refine(workflowId, {
      expectedVersion: state.workflow.version,
      message: 'Invite neighbors to stop by on Sunday instead.',
      answers: { callToAction: 'Visit Mori Matcha this Sunday.' },
    });
    assert.equal(state.workflow.script, null, 'changed factual input invalidates the proposal');
    await assert.rejects(
      api.approveAll(workflowId, staleReviewVersion),
      isApiError(409, 'WORKFLOW_VERSION_CONFLICT'),
    );
    assert.equal(
      (await api.get(workflowId)).workflow.version,
      state.workflow.version,
      'a stale approval is not automatically replayed against current content',
    );
    state = await api.prepare(workflowId, { expectedVersion: state.workflow.version });
    assert.deepEqual(state.workflow.approvals, { brief: null, script: null, scenes: null });
    assert.ok(Object.values(state.verification).every((stage) => stage.state !== 'blocked'));
    await assert.rejects(
      api.render(workflowId, state.workflow.version),
      isApiError(409, 'PROMO_APPROVAL_REQUIRED'),
    );

    state = await api.approveAll(workflowId, state.workflow.version);
    const approvedVersion = state.workflow.version;
    const proposedScenesId = state.workflow.scenes!.id;
    const queued = await api.render(workflowId, approvedVersion);
    const observed: string[] = [];
    const completed = await api.waitForRender(workflowId, queued.id, {
      intervalMs: 10,
      timeoutMs: 5_000,
      onUpdate: (job) => observed.push(job.status),
    });
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.workflowVersion, approvedVersion);
    assert.equal(completed.sourceScenesId, proposedScenesId);
    assert.ok(observed.includes('succeeded'));
    assert.equal(
      (await api.get(workflowId)).workflow.version,
      approvedVersion,
      'rendering and polling do not mutate the reviewed workflow',
    );
    assert.equal((await api.getRenders(workflowId)).length, 1);

    const kit = await api.getPublishKit(workflowId);
    assert.equal(kit.ready, true);
    assert.equal(kit.automaticPosting, false);
    assert.equal(kit.workflowVersion, approvedVersion);
    assert.equal(kit.caption, state.workflow.script!.caption);
    assert.deepEqual(
      {
        width: kit.video.width,
        height: kit.video.height,
        duration: kit.video.duration,
        audio: kit.video.hasAudio,
      },
      { width: 1080, height: 1920, duration: 15, audio: false },
    );
    const downloaded = await fetch(new URL(kit.video.url, origin));
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-type') ?? '', /video\/mp4/);
    assert.match(downloaded.headers.get('content-disposition') ?? '', /attachment/);
    assert.equal(downloaded.headers.get('x-yap-source-stale'), 'false');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), videoBytes);

    state = await api.refine(workflowId, {
      expectedVersion: state.workflow.version,
      answers: { callToAction: 'Visit Mori Matcha next Saturday.' },
    });
    await assert.rejects(api.getPublishKit(workflowId), isApiError(409));
    assert.equal(
      (await api.getRender(workflowId, completed.id)).status,
      'succeeded',
      'the historical render remains valid while the edited workflow needs new review',
    );
    await assert.rejects(
      api.render(workflowId, state.workflow.version),
      isApiError(409, 'PROMO_APPROVAL_REQUIRED'),
    );
  },
);

test(
  'canceling or timing out frontend polling keeps the existing server render resumable',
  { timeout: 30_000 },
  async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const renderer: PromoRenderer = async (options) => {
      await new Promise<void>((resolve, reject) => {
        const stopped = () => reject(options.signal?.reason ?? new Error('Renderer stopped.'));
        options.signal?.addEventListener('abort', stopped, { once: true });
        gate.then(() => {
          options.signal?.removeEventListener('abort', stopped);
          resolve();
        });
        if (options.signal?.aborted) stopped();
      });
      return transportRenderer(options);
    };
    const { api } = await fixture(t, renderer);
    let state = await api.create({
      input: 'Introduce Mori Matcha using our shop photo and invite neighbors to visit.',
      brief: {
        productName: 'Mori Matcha',
        productDescription: 'A neighborhood matcha bar.',
        audience: 'Neighbors',
        keyBenefits: ['Freshly whisked matcha'],
        callToAction: 'Visit Mori this weekend.',
        imageDirection: 'Use our supplied photo.',
        platform: 'instagram',
        duration: 15,
        tone: 'conversational',
      },
    });
    const id = state.workflow.id;
    const photo = await readFile(
      new URL('../../../public/media/wall-beverage.jpg', import.meta.url),
    );
    state = await api.upload(
      id,
      state.workflow.version,
      new File([photo], 'Drink.jpg', { type: 'image/jpeg' }),
    );
    state = await api.prepare(id, { expectedVersion: state.workflow.version });
    state = await api.approveAll(id, state.workflow.version);
    const queued = await api.render(id, state.workflow.version);

    await assert.rejects(
      api.waitForRender(id, queued.id, { intervalMs: 5, timeoutMs: 50 }),
      isApiError(0, 'RENDER_POLL_TIMEOUT'),
    );
    assert.ok(['queued', 'running'].includes((await api.getRender(id, queued.id)).status));

    const controller = new AbortController();
    await assert.rejects(
      api.waitForRender(id, queued.id, {
        signal: controller.signal,
        intervalMs: 5,
        timeoutMs: 5_000,
        onUpdate: () => controller.abort(),
      }),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    assert.equal(
      (await api.getRenders(id)).length,
      1,
      'canceled polling never starts a duplicate render',
    );
    release();
    assert.equal(
      (await api.waitForRender(id, queued.id, { intervalMs: 5, timeoutMs: 5_000 })).status,
      'succeeded',
    );
    assert.equal(
      (await api.get(id)).workflow.version,
      state.workflow.version,
      'stopping and resuming polling does not change approved creative content',
    );
  },
);
