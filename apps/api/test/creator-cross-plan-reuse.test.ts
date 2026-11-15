import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { z } from 'zod';
import { apiErrorSchema } from '@yap/contracts';
import {
  creatorJobResponseSchema,
  creatorJobSchema,
  creatorQuoteResponseSchema,
  creatorQuoteSchema,
  creatorSessionResponseSchema,
  creatorSessionSchema,
  type CreatorSessionResponse,
  type CreatorQuote,
} from '@yap/contracts/creator';
import { workflowResponseSchema } from '@yap/contracts/workflow';
import { createApp } from '../src/app.js';
import { creatorBudgetStateSchema } from '../src/creator-budget.js';
import { clipProvenanceSchema } from '../src/creator-clip-provenance.js';
import type { CreatorVideoProvider } from '../src/creator-video-provider.js';
import { ApiError } from '../src/errors.js';

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const persistedSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessions: creatorSessionSchema.array(),
    jobs: creatorJobSchema.array(),
    quotes: creatorQuoteSchema.array(),
    budget: creatorBudgetStateSchema,
    clipProvenance: clipProvenanceSchema.array(),
  })
  .passthrough();
async function removeFixture(directory: string) {
  const target = resolve(directory);
  assert.ok(
    target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('yap-cross-plan-'),
  );
  await rm(target, { recursive: true, force: true });
}
let encodedVideo: Promise<Buffer> | undefined;
function videoFixture() {
  return (encodedVideo ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yap-cross-plan-encoder-'));
    try {
      const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
      assert.equal(typeof binary, 'string');
      const path = join(directory, 'five-seconds.mp4');
      const encoder = spawn(
        String(binary),
        [
          '-hide_banner',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=720x1280:rate=24',
          '-t',
          '5',
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-threads',
          '2',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-y',
          path,
        ],
        { windowsHide: true, stdio: 'ignore', timeout: 30_000 },
      );
      assert.equal((await once(encoder, 'close'))[0], 0, 'the local FFmpeg fixture must encode');
      return await readFile(path);
    } finally {
      await removeFixture(directory);
    }
  })());
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-cross-plan-reuse-'));
  const creatorDataFile = join(directory, 'creator-sessions.json');
  const creatorDirectory = join(directory, 'creator-videos');
  const bytes = await videoFixture();
  const calls = {
    video: [] as Array<{ clipId: string; imageSha256: string }>,
    audit: [] as string[],
    audio: 0,
    music: 0,
  };
  const errors: unknown[] = [];
  const video: CreatorVideoProvider = {
    configured: true,
    profile: {
      provider: 'fal',
      model: 'seedance-2.5',
      id: 'fal-seedance2.5-portrait',
      label: 'Local Seedance 2.5 fixture',
      ratio: '720:1280',
      nativeWidth: 720,
      nativeHeight: 1280,
      requiresImage: true,
      minSeconds: 4,
      maxSeconds: 10,
      rateCentsPerSecond: 50,
      priceSourceUrl: 'https://example.test/local-video-profile',
      pricingCheckedAt: '2026-11-15T00:00:00.000Z',
    },
    cancel: async () => {},
    async generate({ clip, image, beforeSubmit, onSubmitted }) {
      assert.equal(clip.seconds, 5);
      assert.ok(image?.length);
      calls.video.push({
        clipId: clip.id,
        imageSha256: createHash('sha256').update(image).digest('hex'),
      });
      await beforeSubmit?.();
      if (calls.video.length === 4)
        throw new ApiError(
          422,
          'FIXTURE_VIDEO_REJECTED',
          'The last fixture shot was definitely rejected.',
        );
      await onSubmitted(randomUUID());
      return bytes;
    },
  };
  let app: Awaited<ReturnType<typeof createApp>> | null = null;
  let server: ReturnType<Awaited<ReturnType<typeof createApp>>['listen']> | null = null;
  let origin = '';
  async function open() {
    app = await createApp({
      dataFile: join(directory, 'projects.json'),
      creatorDataFile,
      creatorDirectory,
      workflowProviderConfig: { provider: 'guided' },
      onError: (error) => errors.push(error),
      creatorOptions: {
        video,
        videoProviders: new Map([['fal-seedance2.5-portrait', video]]),
        auditor: {
          configured: true,
          async audit(clip, frames, image, _signal, beforeSubmit) {
            calls.audit.push(clip.id);
            assert.equal(frames.length, 3);
            assert.ok(frames.every((frame) => frame.length > 100));
            assert.ok(image?.length);
            await beforeSubmit?.();
            return {
              technicalPassed: true,
              visionPassed: true,
              summary: 'The local fixture frames passed review.',
              issues: [],
            };
          },
        },
        voiceover: {
          configured: true,
          async narrate() {
            calls.audio++;
            throw new ApiError(
              422,
              'UNEXPECTED_FIXTURE_AUDIO',
              'This test must block before narration.',
            );
          },
        },
        music: {
          tracks: [],
          path() {
            calls.music++;
            throw new Error('No fixture music is selected.');
          },
        },
      },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function close() {
    if (!app || !server) return;
    const ownedApp = app,
      ownedServer = server;
    app = null;
    server = null;
    await ownedApp.locals.shutdown();
    ownedServer.closeAllConnections();
    await new Promise<void>((done, reject) =>
      ownedServer.close((error) => (error ? reject(error) : done())),
    );
  }
  await open();
  t.after(async () => {
    try {
      await close();
      assert.deepEqual(errors, []);
    } finally {
      await removeFixture(directory);
    }
  });
  const request = (path: string, init?: RequestInit) => fetch(origin + path, init);
  const creator = (path: string, init?: RequestInit) => request('/api/creator' + path, init);
  const saved = async () =>
    persistedSchema.parse(JSON.parse(await readFile(creatorDataFile, 'utf8')));
  async function reopenAsLegacy() {
    await close();
    const before = await saved();
    assert.ok(before.clipProvenance.some((record) => record.kind === 'generated'));
    const legacy = {
      ...before,
      clipProvenance: before.clipProvenance.filter(
        (record) => record.kind === 'legacy_current_plan',
      ),
    };
    await writeFile(creatorDataFile, JSON.stringify(legacy, null, 2));
    await open();
    const after = await saved();
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.quotes, before.quotes);
    assert.deepEqual(after.budget, before.budget);
    assert.equal(after.clipProvenance.length, 0);
  }
  return {
    directory,
    creatorDirectory,
    creatorDataFile,
    calls,
    request,
    creator,
    saved,
    reopenAsLegacy,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function stateResponse(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return creatorSessionResponseSchema.parse(await response.json());
}
async function getState(f: Fixture, id: string) {
  return stateResponse(await f.creator(`/sessions/${id}`));
}
async function prepare(f: Fixture, value: CreatorSessionResponse) {
  return stateResponse(
    await f.creator(
      `/sessions/${value.session.id}/prepare`,
      json('POST', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
      }),
    ),
  );
}
async function upload(f: Fixture, value: CreatorSessionResponse, index: number) {
  const photo = await sharp({
    create: {
      width: 80,
      height: 100,
      channels: 3,
      background: { r: 40 + index * 20, g: 90, b: 160 - index * 10 },
    },
  })
    .jpeg()
    .toBuffer();
  const response = await f.request(
    `/api/workflows/${value.workflow.id}/assets?expectedVersion=${value.workflow.version}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': `source-${index}.jpg` },
      body: new Uint8Array(photo),
    },
  );
  assert.equal(response.status, 201, await response.clone().text());
  const workflow = workflowResponseSchema.parse(await response.json()).workflow;
  return { ...value, workflow };
}
async function quote(f: Fixture, value: CreatorSessionResponse) {
  const response = await f.creator(
    `/sessions/${value.session.id}/quote`,
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return creatorQuoteResponseSchema.parse(await response.json()).quote;
}
async function approve(f: Fixture, value: CreatorSessionResponse, priced: CreatorQuote) {
  return stateResponse(
    await f.creator(
      `/sessions/${value.session.id}/approve`,
      json('POST', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        planId: value.session.plan!.id,
        quoteId: priced.id,
        reviewed: true,
        costReviewed: true,
      }),
    ),
  );
}
function produce(f: Fixture, value: CreatorSessionResponse) {
  return f.creator(
    `/sessions/${value.session.id}/produce`,
    json('POST', {
      expectedVersion: value.session.version,
      approvalId: value.session.approval!.id,
      quoteId: value.session.approval!.quoteId!,
      requestId: randomUUID(),
    }),
  );
}
async function finished(f: Fixture, id: string, jobId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await f.creator(`/sessions/${id}/jobs/${jobId}`);
    assert.equal(response.status, 200);
    const value = creatorJobResponseSchema.parse(await response.json());
    if (['failed', 'canceled', 'succeeded'].includes(value.job.status)) return value;
    await delay(25);
  }
  assert.fail('The local FFmpeg production fixture did not finish within 60 seconds.');
}

async function replacementReady(f: Fixture, narration = false) {
  let value = await stateResponse(
    await f.creator(
      '/sessions',
      json('POST', {
        input: {
          mode: 'media',
          prompt: 'Film our handmade ceramic cups with quiet product closeups.',
          urls: [],
          duration: 20,
          platform: 'instagram',
          tone: 'conversational',
        },
      }),
    ),
    201,
  );
  for (let index = 0; index < 4; index++) value = await upload(f, value, index);
  value = await prepare(f, value);
  assert.equal(value.session.plan!.clips.length, 4);
  const clips = value.session.plan!.clips.map((clip, index) => ({
    ...clip,
    seconds: 5,
    assetId: value.workflow.assets[index]!.id,
    videoProfileId: 'fal-seedance2.5-portrait' as const,
    prompt: `Preserve the supplied ceramic cup in product shot ${index + 1}.`,
    camera: 'A slow controlled push toward the cup.',
    lighting: 'A soft neutral studio key.',
    referenceIds: [],
  }));
  value = await stateResponse(
    await f.creator(
      `/sessions/${value.session.id}/plan`,
      json('PATCH', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        clips,
        caption: 'Handmade ceramic cups.',
        audio: { voice: null, musicTrackId: null },
        subtitlesEnabled: false,
        outputProfileId: 'portrait-720',
      }),
    ),
  );
  const firstQuote = await quote(f, value);
  assert.equal(firstQuote.maxCostCents, 1040);
  value = await approve(f, value, firstQuote);
  const started = await produce(f, value);
  assert.equal(started.status, 202, await started.clone().text());
  const first = creatorJobResponseSchema.parse(await started.json()).job;
  const failed = await finished(f, value.session.id, first.id);
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.error?.code, 'FIXTURE_VIDEO_REJECTED');
  assert.equal(failed.job.clips.filter((clip) => clip.status === 'passed').length, 3);
  assert.equal(f.calls.video.length, 4);
  assert.equal(f.calls.audit.length, 3);
  await f.reopenAsLegacy();
  value = await getState(f, value.session.id);
  const original = structuredClone(value);
  const originalJob = (await f.saved()).jobs.find((job) => job.id === first.id)!;
  const originalBudget = (await f.saved()).budget;
  const anchor = await quote(f, value);
  assert.equal(anchor.clips.filter((clip) => clip.reuse).length, 3);
  const anchored = (await f.saved()).clipProvenance;
  assert.equal(anchored.filter((record) => record.output).length, 3);
  assert.ok(
    anchored.every(
      (record) =>
        record.kind === 'legacy_current_plan' && record.planId === original.session.plan!.id,
    ),
  );
  await quote(f, value);
  assert.deepEqual(
    (await f.saved()).clipProvenance,
    anchored,
    'capturing the exact original plan twice is idempotent',
  );
  assert.deepEqual((await f.saved()).budget, originalBudget);
  value = await upload(f, value, 4);
  const stale = await f.creator(
    `/sessions/${value.session.id}/quote`,
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
    }),
  );
  assert.equal(stale.status, 409, 'a source change cannot attest the old plan');
  assert.deepEqual((await f.saved()).clipProvenance, anchored);
  value = await prepare(f, await getState(f, value.session.id));
  const newScenes = value.session.plan!.clips.map((clip) => clip.sceneId);
  assert.notEqual(value.session.plan!.id, original.session.plan!.id);
  assert.ok(newScenes.every((id, index) => id !== original.session.plan!.clips[index]!.sceneId));
  value = await stateResponse(
    await f.creator(
      `/sessions/${value.session.id}/plan`,
      json('PATCH', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        clips: original.session.plan!.clips.map((clip, index) => ({
          ...clip,
          sceneId: newScenes[index],
          assetId: index === 3 ? value.workflow.assets.at(-1)!.id : clip.assetId,
        })),
        caption: original.session.plan!.caption,
        audio: { voice: narration ? 'alloy' : null, musicTrackId: null },
        subtitlesEnabled: false,
        outputProfileId: 'portrait-720',
      }),
    ),
  );
  const nextQuote = await quote(f, value);
  assert.equal(nextQuote.clips.filter((clip) => clip.reuse).length, 3);
  assert.ok(
    nextQuote.clips
      .slice(0, 3)
      .every((clip) => clip.reuse?.jobId === first.id && clip.costCents === 0),
  );
  assert.equal(nextQuote.clips[3]!.reuse, null);
  assert.equal(nextQuote.clips[3]!.attempt, 1, 'a different final source is a new creative input');
  assert.equal(nextQuote.clips[3]!.costCents, 260);
  assert.deepEqual(
    (await f.saved()).clipProvenance.filter((record) => record.jobId === first.id),
    anchored,
  );
  const approved = await approve(f, value, nextQuote);
  return { approved, nextQuote, originalJob, originalBudget, anchored, first };
}

test(
  'a fresh plan reuses three attested clips and generates only the changed final photo before assembling twenty seconds',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const { approved, nextQuote, originalJob, originalBudget, anchored, first } =
      await replacementReady(f);
    assert.equal(nextQuote.maxCostCents, 260);
    const response = await produce(f, approved);
    assert.equal(response.status, 202, await response.clone().text());
    const started = creatorJobResponseSchema.parse(await response.json()).job;
    const result = await finished(f, approved.session.id, started.id);
    assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job.error));
    assert.equal(result.job.output?.duration, 20);
    assert.equal(result.job.output?.hasAudio, false);
    assert.equal(result.job.clips.filter((clip) => clip.status === 'passed').length, 4);
    assert.equal(f.calls.video.length, 5);
    assert.equal(f.calls.audit.length, 4);
    assert.equal(f.calls.audio, 0);
    assert.equal(f.calls.music, 0);
    assert.equal(f.calls.video.at(-1)!.clipId, approved.session.plan!.clips[3]!.id);
    assert.equal(f.calls.video.at(-1)!.imageSha256, approved.workflow.assets.at(-1)!.sha256);
    const persisted = await f.saved();
    assert.deepEqual(
      persisted.jobs.find((job) => job.id === first.id),
      originalJob,
      'recovery never rewrites the old job',
    );
    for (const reservation of originalBudget.reservations)
      assert.deepEqual(
        persisted.budget.reservations.find((item) => item.id === reservation.id),
        reservation,
      );
    assert.equal(persisted.budget.reservations.length, originalBudget.reservations.length + 1);
    assert.deepEqual(
      persisted.clipProvenance.filter((record) => record.jobId === first.id),
      anchored,
    );
    const video = await f.creator(`/sessions/${approved.session.id}/jobs/${started.id}/video`);
    assert.equal(video.status, 200);
    assert.match(video.headers.get('content-type') ?? '', /video\/mp4/);
    const delivered = Buffer.from(await video.arrayBuffer());
    assert.equal(delivered.length, result.job.output!.bytes);
    assert.equal(createHash('sha256').update(delivered).digest('hex'), result.job.output!.sha256);
  },
);

test(
  'a later reused clip corrupted after quote approval blocks every new provider, audit and audio call before budget admission',
  { timeout: 120_000 },
  async (t) => {
    const f = await fixture(t);
    const { approved, nextQuote, first } = await replacementReady(f, true);
    assert.ok(
      nextQuote.audioCents > 0,
      'the approved quote must contain real narration work that preflight can prevent',
    );
    assert.equal(nextQuote.narratedSegments, 4);
    const later = nextQuote.clips[2]!;
    assert.ok(later.reuse);
    assert.equal(later.reuse.jobId, first.id);
    const path = resolve(
      f.creatorDirectory,
      later.reuse.jobId,
      `${later.clipId}-${later.reuse.attempt}.mp4`,
    );
    assert.ok(path.startsWith(resolve(f.creatorDirectory) + sep));
    const corrupted = Buffer.from(await readFile(path));
    assert.ok(corrupted.length > 1000);
    const last = corrupted.length - 1;
    corrupted[last] = corrupted[last]! ^ 0xff;
    await writeFile(path, corrupted);
    const before = await f.saved();
    const calls = structuredClone(f.calls);
    const response = await produce(f, approved);
    assert.equal(response.status, 500, await response.clone().text());
    const error = apiErrorSchema.parse(await response.json()).error;
    assert.equal(error.code, 'CREATOR_CLIP_CORRUPTED');
    const after = await f.saved();
    assert.deepEqual(
      f.calls,
      calls,
      'no new video, visual review, narration or music work is allowed',
    );
    assert.equal(f.calls.video.length, 4);
    assert.equal(f.calls.audit.length, 3);
    assert.equal(f.calls.audio, 0);
    assert.deepEqual(
      after.budget,
      before.budget,
      'corruption must be found before any spending reservation',
    );
    assert.deepEqual(
      after.jobs,
      before.jobs,
      'the corrupt reuse cannot admit a new production job',
    );
    assert.deepEqual(after.quotes, before.quotes, 'the approved quote remains unconsumed');
    assert.deepEqual(
      after.clipProvenance,
      before.clipProvenance,
      'corruption cannot rewrite creative identity',
    );
  },
);
