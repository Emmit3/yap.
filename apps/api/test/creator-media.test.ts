import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { CreatorClip } from '@yap/contracts/creator';
import {
  createCreatorVisionAuditor,
  inspectCreatorClip,
  silenceCreatorClip,
} from '../src/creator-media.js';
import { creatorVideoPrompt } from '../src/creator-video-provider.js';

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A ceramic cup with a round handle, centered on a studio plinth.',
  camera: 'Slow push in.',
  lighting: 'Soft side light.',
};
function auditResponse(result: unknown): Response {
  return Response.json({
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
  });
}
const sampleFrame = () =>
  sharp({ create: { width: 360, height: 640, channels: 3, background: '#555' } })
    .jpeg()
    .toBuffer();

test('provider native audio is removed from stored silent clips without changing the video dimensions', async (t) => {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'yap-media-silent-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(root + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const encoder: unknown = createRequire(import.meta.url)('ffmpeg-static');
  assert.ok(typeof encoder === 'string');
  const path = join(directory, 'provider.mp4');
  await promisify(execFile)(
    encoder,
    [
      '-hide_banner',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:s=720x1280:r=24:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-y',
      path,
    ],
    { windowsHide: true },
  );
  await silenceCreatorClip(path, new AbortController().signal);
  const result = await promisify(execFile)(
    encoder,
    ['-hide_banner', '-nostdin', '-i', path, '-f', 'null', '-'],
    { windowsHide: true },
  );
  assert.match(result.stderr, /720x1280/);
  assert.doesNotMatch(result.stderr, /Stream[^\r\n]*Audio:/);
});

test('technical review rejects tiny portrait footage before upscaling and accepts native 720p', async (t) => {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'yap-media-resolution-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(root + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const encoder: unknown = createRequire(import.meta.url)('ffmpeg-static');
  assert.ok(typeof encoder === 'string');
  for (const [width, height, expected] of [
    [90, 160, false],
    [720, 1280, true],
  ] as const) {
    const path = join(directory, `${width}x${height}.mp4`);
    await promisify(execFile)(
      encoder,
      [
        '-hide_banner',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        `color=c=gray:s=${width}x${height}:r=24:d=5`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-an',
        '-y',
        path,
      ],
      { windowsHide: true },
    );
    const result = await inspectCreatorClip(path, clip, new AbortController().signal);
    assert.equal(result.audit.technicalPassed, expected);
    assert.equal(result.frames.length, expected ? 3 : 0);
    if (expected) assert.deepEqual(result.audit.sampledAtSeconds, [5 / 6, 2.5, 25 / 6]);
    else assert.match(result.audit.issues.join(' '), /at least 720×1280.*90×160/);
  }
});

test('blocking observed findings override a passing model boolean and preserve a bounded repair suggestion', async () => {
  const frame = await sampleFrame();
  const suggestedRevision = {
    prompt: clip.prompt + ' Preserve the round handle and original silhouette.',
    camera: 'Locked camera; centered subject with space around the handle.',
    lighting: clip.lighting,
    reason: 'The handle deforms in the second sampled frame.',
  };
  let calls = 0;
  const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () => {
    calls++;
    return auditResponse({
      passed: true,
      summary: 'The second frame has visible handle deformation; motion between stills is unknown.',
      issues: ['The handle deforms in frame 1.'],
      findings: [
        {
          category: 'subject',
          severity: 'blocking',
          frameIndices: [1],
          observation: 'The round cup handle is visibly fused into the body in frame 1.',
          suggestedFix: 'Preserve the reference silhouette and use a locked camera.',
        },
      ],
      suggestedRevision,
    });
  });
  const original = structuredClone(clip);
  const result = await auditor.audit(
    clip,
    [frame, frame, frame],
    undefined,
    new AbortController().signal,
  );
  assert.equal(result.visionPassed, false);
  assert.equal(result.findings?.[0]?.severity, 'blocking');
  assert.deepEqual(result.suggestedRevision, suggestedRevision);
  assert.ok(creatorVideoPrompt({ ...clip, ...suggestedRevision }).length <= 1000);
  assert.deepEqual(result.sampledAtSeconds, [5 / 6, 2.5, 25 / 6]);
  assert.deepEqual(clip, original, 'review does not rewrite the approved shot');
  assert.equal(calls, 1, 'a suggestion must not submit a second model or generation request');
});

test('a repair that exceeds the provider prompt limit is discarded without truncating it', async () => {
  const frame = await sampleFrame();
  const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () =>
    auditResponse({
      passed: false,
      summary: 'A simpler shot is needed.',
      issues: ['Subject deformation.'],
      findings: [],
      suggestedRevision: {
        prompt: 'p'.repeat(900),
        camera: 'c'.repeat(100),
        lighting: 'Soft light.',
        reason: 'Reduce deformation.',
      },
    }),
  );
  const result = await auditor.audit(
    clip,
    [frame, frame, frame],
    undefined,
    new AbortController().signal,
  );
  assert.equal(result.suggestedRevision, null);
  assert.equal(result.visionPassed, false);
});

test('blocking camera or continuity claims without observed frame evidence reject the audit', async () => {
  const frame = await sampleFrame();
  for (const category of ['camera', 'continuity']) {
    let calls = 0;
    const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () => {
      calls++;
      return auditResponse({
        passed: true,
        summary: 'The provider claims motion failed without identifying visible evidence.',
        issues: [],
        findings: [
          {
            category,
            severity: 'blocking',
            frameIndices: [],
            observation: 'The camera trajectory is incoherent between sampled frames.',
            suggestedFix: 'Use a locked camera.',
          },
        ],
        suggestedRevision: null,
      });
    });
    await assert.rejects(
      auditor.audit(clip, [frame, frame, frame], undefined, new AbortController().signal),
      { code: 'CREATOR_AUDIT_INVALID' },
    );
    assert.equal(calls, 1, 'invalid findings must not trigger a retry or invent frame evidence');
  }
});

test('sampled review treats unassessable camera motion as a coverage warning rather than a false failure', async () => {
  const frame = await sampleFrame();
  const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async (_url, init) => {
    const input = JSON.parse(String(init?.body)).input[0].content[0].text;
    assert.match(input, /stills cannot establish camera motion/);
    assert.match(input, /unassessable limits/);
    assert.match(input, /never approval or permission to regenerate/);
    return auditResponse({
      passed: true,
      summary:
        'Sampled compositions match. Continuous camera motion cannot be assessed from stills.',
      issues: [],
      findings: [
        {
          category: 'camera',
          severity: 'warning',
          frameIndices: [],
          observation: 'Continuous camera motion is not observable from these three stills.',
          suggestedFix: 'Watch the whole clip to review the requested slow push in.',
        },
      ],
      suggestedRevision: null,
    });
  });
  const result = await auditor.audit(
    clip,
    [frame, frame, frame],
    undefined,
    new AbortController().signal,
  );
  assert.equal(result.visionPassed, true);
  assert.equal(result.findings?.[0]?.severity, 'warning');
  assert.equal(result.suggestedRevision, null);
});

test('frame review normalizes PNG and WebP creator references to actual bounded JPEG bytes', async () => {
  const frame = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#555' } })
    .jpeg()
    .toBuffer();
  for (const format of ['png', 'webp'] as const) {
    const image = await sharp({
      create: { width: 1200, height: 1800, channels: 4, background: '#aaa' },
    })
      [format]()
      .toBuffer();
    let inspected = false;
    const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async (_input, init) => {
      const payload = JSON.parse(String(init?.body)),
        images = payload.input[0].content.filter(
          (item: { type: string }) => item.type === 'input_image',
        );
      assert.equal(images.length, 4);
      assert.match(images[0].image_url, /^data:image\/jpeg;base64,/);
      const bytes = Buffer.from(images[0].image_url.split(',')[1], 'base64');
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.format, 'jpeg');
      assert.ok(metadata.width! <= 640 && metadata.height! <= 640);
      inspected = true;
      return Response.json({
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  passed: true,
                  summary: 'Sampled frames match the reference.',
                  issues: [],
                }),
              },
            ],
          },
        ],
      });
    });
    const result = await auditor.audit(
      {
        id: randomUUID(),
        sceneId: randomUUID(),
        seconds: 5,
        prompt: 'A ceramic cup.',
        camera: 'Slow push in.',
        lighting: 'Soft side light.',
      },
      [frame, frame, frame],
      image,
      new AbortController().signal,
    );
    assert.equal(result.visionPassed, true);
    assert.equal(inspected, true);
  }
});
