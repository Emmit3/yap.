import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { workflowSchema, type Workflow, type WorkflowImageAsset } from '@yap/contracts/workflow';
import { renderPromoVideo } from '../src/video-renderer.js';

const installedEncoder: unknown = createRequire(import.meta.url)('ffmpeg-static');
const ffmpegStatic = typeof installedEncoder === 'string' ? installedEncoder : null;

async function fixture() {
  const photoBuffers = await Promise.all(
    ['#ed4433', '#559e2e'].map((background) =>
      sharp({ create: { width: 400, height: 400, channels: 3, background } })
        .png()
        .toBuffer(),
    ),
  );
  const now = new Date().toISOString();
  const assets: WorkflowImageAsset[] = photoBuffers.map((photo, index) => ({
    id: randomUUID(),
    filename: `product '${index}' $(nothing).png`,
    mimeType: 'image/png',
    bytes: photo.length,
    width: 400,
    height: 400,
    sha256: createHash('sha256').update(photo).digest('hex'),
    description: 'A supplied product photo for the renderer integration test.',
    createdAt: now,
  }));
  const scriptId = randomUUID();
  const scenesId = randomUUID();
  const segments = [7, 8].map((seconds, index) => ({
    id: randomUUID(),
    text: index === 0 ? 'Fresh matcha for your morning ritual.' : 'Come visit Moss Matcha today.',
    seconds,
  }));
  const workflow = workflowSchema.parse({
    id: randomUUID(),
    version: 7,
    contentRevision: 2,
    title: 'A matcha shop promo',
    input: 'Introduce our matcha shop using these photos.',
    brief: {
      productName: 'Moss <g> & "Matcha"',
      productDescription: 'A local matcha shop.',
      audience: 'Neighbors looking for a morning drink.',
      keyBenefits: ['Freshly prepared matcha'],
      callToAction: 'Visit our shop today.',
      imageDirection: 'Feature the supplied product photos without inventing new products.',
      tone: 'conversational',
      platform: 'instagram',
      duration: 15,
    },
    assets,
    messages: [],
    questions: [],
    script: {
      id: scriptId,
      sourceRevision: 2,
      hook: 'A fresh start.',
      segments,
      caption: 'Visit Moss Matcha.',
      provider: 'guided',
      createdAt: now,
    },
    scenes: {
      id: scenesId,
      sourceScriptId: scriptId,
      scenes: segments.map((segment, index) => ({
        id: randomUUID(),
        scriptSegmentId: segment.id,
        seconds: segment.seconds,
        visual: 'Use the supplied product photo.',
        onScreenText: index === 0 ? 'Fresh <matcha> & a calmer morning.' : 'Come visit us today.',
        assetIds: [assets[index]!.id],
      })),
      provider: 'guided',
      createdAt: now,
    },
    approvals: { brief: 2, script: scriptId, scenes: scenesId },
    createdAt: now,
    updatedAt: now,
  });
  return {
    workflow,
    loadAsset: async (asset: WorkflowImageAsset) =>
      photoBuffers[assets.findIndex((candidate) => candidate.id === asset.id)]!,
  };
}

async function runFfmpeg(args: string[]) {
  assert.ok(
    ffmpegStatic,
    'The renderer integration test requires the installed ffmpeg-static binary.',
  );
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn(ffmpegStatic!, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (data: Buffer) => stdout.push(data));
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout: Buffer.concat(stdout), stderr })
        : reject(new Error(`FFmpeg validation failed (${code}): ${stderr}`)),
    );
  });
}

test(
  'renders real supplied photos and XML-safe copy into a playable exact-duration vertical MP4',
  { timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'yap-render-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { workflow, loadAsset } = await fixture();
    const outputPath = join(directory, "promo ' $() ;.mp4");
    const progress: number[] = [];
    const rendered = await renderPromoVideo({
      workflow,
      loadAsset,
      outputPath,
      onProgress: (value) => progress.push(value),
    });
    const data = await readFile(outputPath);
    assert.equal(rendered.bytes, (await stat(outputPath)).size);
    assert.equal(rendered.sha256, createHash('sha256').update(data).digest('hex'));
    assert.equal(data.subarray(4, 8).toString('ascii'), 'ftyp');
    assert.deepEqual(
      { width: rendered.width, height: rendered.height, duration: rendered.duration },
      { width: 1080, height: 1920, duration: 15 },
    );
    assert.equal(progress.at(-1), 1);
    const decoded = await runFfmpeg([
      '-hide_banner',
      '-i',
      outputPath,
      '-t',
      '0.2',
      '-f',
      'null',
      '-',
    ]);
    assert.match(decoded.stderr, /Duration: 00:00:15\.00/);
    assert.match(decoded.stderr, /Video: h264/);
    assert.match(decoded.stderr, /yuv420p/);
    assert.match(decoded.stderr, /1080x1920/);
    assert.match(decoded.stderr, /24 fps/);
    assert.doesNotMatch(decoded.stderr, /Audio:/);
    for (const [seconds, channel] of [
      [2, 0],
      [10, 1],
    ] as const) {
      const image = await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(seconds),
        '-i',
        outputPath,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ]);
      const { data: pixel } = await sharp(image.stdout)
        .extract({ left: 540, top: 750, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.ok(
        pixel[channel]! > pixel[1 - channel]! * 1.5,
        `The supplied photo should still be visible at ${seconds}s.`,
      );
    }
  },
);

test('rejects missing photos, unapproved stages, stale scenes, and out-of-workflow asset references', async () => {
  const fixtureValue = await fixture();
  const outputPath = join(tmpdir(), `unused-render-${randomUUID()}.mp4`);
  const invalid: Array<[Workflow, string]> = [
    [{ ...fixtureValue.workflow, assets: [] }, 'RENDER_IMAGES_REQUIRED'],
    [
      { ...fixtureValue.workflow, approvals: { ...fixtureValue.workflow.approvals, scenes: null } },
      'RENDER_APPROVAL_REQUIRED',
    ],
    [
      {
        ...fixtureValue.workflow,
        scenes: { ...fixtureValue.workflow.scenes!, sourceScriptId: randomUUID() },
      },
      'RENDER_STALE_SCENES',
    ],
    [
      {
        ...fixtureValue.workflow,
        scenes: {
          ...fixtureValue.workflow.scenes!,
          scenes: fixtureValue.workflow.scenes!.scenes.map((scene, index) =>
            index === 0 ? { ...scene, assetIds: [randomUUID()] } : scene,
          ),
        },
      },
      'RENDER_REFERENCE_INVALID',
    ],
  ];
  for (const [workflow, code] of invalid) {
    await assert.rejects(
      renderPromoVideo({
        workflow,
        outputPath,
        loadAsset: async () => {
          throw new Error('Invalid references must fail before loading any photo.');
        },
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === code,
    );
  }
});

test('refuses changed image bytes and honors cancellation before loading a photo', async () => {
  const { workflow } = await fixture();
  const outputPath = join(tmpdir(), `unused-render-${randomUUID()}.mp4`);
  await assert.rejects(
    renderPromoVideo({
      workflow,
      outputPath,
      loadAsset: async () => Buffer.from('not the supplied image'),
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'RENDER_IMAGE_INTEGRITY',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderPromoVideo({
      workflow,
      outputPath,
      signal: controller.signal,
      loadAsset: async () => {
        throw new Error('Cancelled render must not load a photo.');
      },
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'RENDER_CANCELLED',
  );
});
