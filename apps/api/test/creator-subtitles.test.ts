import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import type { CreatorPlan, CreatorJob } from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import {
  createSubtitleSnapshot,
  sceneSubtitleWindows,
  subtitleSrt,
  writeCreatorSubtitles,
} from '../src/creator-subtitles.js';
import { assembleCreatorClips, prepareCreatorVoice } from '../src/creator-media.js';
import { layoutVoiceover } from '../src/creator-audio.js';
import { CreatorJobs, type CreatorJobsOptions } from '../src/creator-jobs.js';

function source() {
  const a = randomUUID(),
    b = randomUUID(),
    sa = randomUUID(),
    sb = randomUUID();
  const plan = {
    id: randomUUID(),
    clips: [
      { sceneId: sa, seconds: 4 },
      { sceneId: sb, seconds: 4 },
    ],
  } as CreatorPlan;
  const workflow = {
    version: 3,
    script: {
      id: randomUUID(),
      caption: 'The social caption is never a subtitle.',
      segments: [
        { id: a, text: 'First approved line.' },
        { id: b, text: 'Second approved line.' },
      ],
    },
    scenes: {
      scenes: [
        { id: sa, scriptSegmentId: a },
        { id: sb, scriptSegmentId: b },
      ],
    },
  } as unknown as Workflow;
  return { plan, workflow, a, b, sa, sb };
}

test('scene subtitles follow clip order, preserve repeated groups and never use the social caption', () => {
  const { plan, workflow, sa, sb, a, b } = source();
  plan.clips = [
    { sceneId: sa, seconds: 2 },
    { sceneId: sa, seconds: 2 },
    { sceneId: sb, seconds: 2 },
    { sceneId: sa, seconds: 2 },
  ] as CreatorPlan['clips'];
  const snapshot = createSubtitleSnapshot(plan, workflow);
  assert.equal(snapshot.timingSource, 'scene');
  assert.deepEqual(
    snapshot.windows.map(({ segmentId, start, end }) => ({ segmentId, start, end })),
    [
      { segmentId: a, start: 0, end: 4 },
      { segmentId: b, start: 4, end: 6 },
      { segmentId: a, start: 6, end: 8 },
    ],
  );
  assert.ok(!subtitleSrt(snapshot).includes('social caption'));
  assert.equal(snapshot.planId, plan.id);
  assert.equal(snapshot.scriptId, workflow.script!.id);
  assert.equal(snapshot.workflowVersion, 3);
});

test('narration cues use supplied post-trim, post-tempo placements with complete literal Unicode text', () => {
  const { plan, workflow, a, b } = source();
  const text = 'Café Привет <b> {\\an8} \\N & safe';
  const snapshot = createSubtitleSnapshot(plan, workflow, [
    { segmentId: a, text, start: 0.2, end: 3.8 },
    { segmentId: b, text: 'The delayed line.', start: 4.32, end: 7.52 },
  ]);
  assert.equal(snapshot.timingSource, 'narration');
  assert.equal(snapshot.cues[0]!.startMs, 200);
  assert.equal(snapshot.cues.at(-1)!.endMs, 7520);
  assert.equal(snapshot.windows[0]!.text, text);
  assert.match(subtitleSrt(snapshot), /Café Привет/);
  assert.match(subtitleSrt(snapshot), /<b>/);
  assert.match(subtitleSrt(snapshot), /& safe/);
  assert.match(subtitleSrt(snapshot), /00:00:04,320 --> 00:00:07,520/);
});

test('dense, overlapping or out-of-film subtitle windows fail before truncating text', () => {
  const { plan, workflow, a, b } = source();
  assert.throws(
    () =>
      createSubtitleSnapshot(plan, workflow, [
        { segmentId: a, text: 'x'.repeat(1000), start: 0, end: 4 },
      ]),
    /cannot fit readable subtitles/,
  );
  assert.throws(
    () =>
      createSubtitleSnapshot(plan, workflow, [
        { segmentId: a, text: 'One.', start: 0, end: 5 },
        { segmentId: b, text: 'Two.', start: 4, end: 8 },
      ]),
    /cannot fit readable subtitles/,
  );
  assert.throws(
    () =>
      createSubtitleSnapshot(plan, workflow, [{ segmentId: a, text: 'One.', start: 0, end: 8.01 }]),
    /cannot fit readable subtitles/,
  );
  assert.deepEqual(
    sceneSubtitleWindows(plan, workflow).map(({ start, end }) => [start, end]),
    [
      [0, 4],
      [4, 8],
    ],
  );
});

test('long wide-glyph copy wraps completely without losing its tail or clipping one line', () => {
  const { plan, workflow, a } = source();
  const text = 'W'.repeat(64);
  const snapshot = createSubtitleSnapshot(plan, workflow, [
    { segmentId: a, text, start: 0, end: 8 },
  ]);
  assert.equal(snapshot.cues.map((cue) => cue.text.replaceAll('\n', '')).join(''), text);
  assert.ok(snapshot.cues.every((cue) => cue.text.split('\n').every((line) => line.length <= 16)));
  assert.ok(snapshot.cues.every((cue) => cue.endMs - cue.startMs >= 590));
});

test('historical, failed and canceled jobs cannot expose partial or fabricated subtitles', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yap-subtitle-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = new CreatorJobs({ directory } as CreatorJobsOptions);
  const { plan, workflow } = source(),
    id = randomUUID();
  await mkdir(join(directory, id));
  const receipt = await writeCreatorSubtitles(
    join(directory, id),
    createSubtitleSnapshot(plan, workflow),
  );
  const historical = { id, status: 'succeeded', output: { bytes: 1 } } as CreatorJob;
  await assert.rejects(jobs.verifySubtitles(historical), { code: 'CREATOR_SUBTITLES_NOT_READY' });
  for (const status of ['failed', 'canceled'] as const)
    await assert.rejects(
      jobs.verifySubtitles({
        ...historical,
        status,
        output: { ...historical.output!, subtitles: receipt },
      }),
      { code: 'CREATOR_SUBTITLES_NOT_READY' },
    );
});

async function encode(args: string[]) {
  const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
  assert.equal(typeof binary, 'string');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary as string, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '';
    child.stderr.on('data', (data: Buffer) => {
      log = (log + data.toString()).slice(-64000);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(log) : reject(new Error(log))));
  });
}

test(
  'real FFmpeg burns literal Unicode in safe portrait margins, preserves audio and uses measured narration timing',
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "yap subtitle's [fixture]-"));
    t.after(async () => {
      if (process.env.CREATOR_SUBTITLE_EVIDENCE_DIRECTORY) {
        const evidence = process.env.CREATOR_SUBTITLE_EVIDENCE_DIRECTORY;
        await mkdir(evidence, { recursive: true });
        for (const name of [
          'before.png',
          'during.png',
          'after.png',
          'wide.png',
          'subtitles.srt',
          'subtitles.ass',
          'subtitle-cues.json',
          'final.mp4',
          'decode.log',
        ])
          await copyFile(join(directory, name), join(evidence, name)).catch(() => undefined);
      }
      await rm(directory, { recursive: true, force: true });
    });
    const clip = join(directory, 'clip.mp4'),
      wave = join(directory, 'voice.wav');
    await encode([
      '-hide_banner',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=720x1280:r=24:d=4',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      '-y',
      clip,
    ]);
    await encode([
      '-hide_banner',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-af',
      'adelay=500,apad=pad_dur=0.5',
      '-c:a',
      'pcm_s16le',
      '-y',
      wave,
    ]);
    const pcm = join(directory, 'voice.pcm'),
      signal = AbortSignal.timeout(150000);
    const measured = await prepareCreatorVoice(wave, pcm, signal);
    assert.ok(Math.abs(measured - 4) < 0.05, 'leading and trailing silence are actually removed');
    const placed = layoutVoiceover(
      [
        { start: 0, duration: measured },
        { start: 4, duration: measured },
      ],
      8,
    );
    assert.ok(placed[0]!.tempo > 1, 'fixture requires tempo adjustment');
    const { plan, workflow, a, b } = source();
    const snapshot = createSubtitleSnapshot(
      plan,
      workflow,
      [a, b].map((segmentId, index) => ({
        segmentId,
        text: index === 0 ? 'Café Привет <b> {\\an8}' : 'W'.repeat(40),
        start: placed[index]!.at,
        end: placed[index]!.at + measured / placed[index]!.tempo,
      })),
    );
    const receipt = await writeCreatorSubtitles(directory, snapshot);
    const srt = await readFile(join(directory, 'subtitles.srt'));
    assert.equal(receipt.sha256, createHash('sha256').update(srt).digest('hex'));
    const output = join(directory, 'final.mp4');
    const result = await assembleCreatorClips(
      [clip, clip],
      output,
      directory,
      [4, 4],
      signal,
      {
        voices: placed.map((place) => ({ path: pcm, ...place })),
      },
      true,
    );
    assert.equal(result.hasAudio, true);
    assert.ok(Math.abs(result.duration - 8) <= 1 / 24);
    assert.deepEqual([result.width, result.height], [1080, 1920]);
    const before = join(directory, 'before.png'),
      during = join(directory, 'during.png'),
      after = join(directory, 'after.png'),
      wide = join(directory, 'wide.png');
    for (const [at, path] of [
      [0.04, before],
      [1, during],
      [7.84, after],
      [5, wide],
    ] as const)
      await encode([
        '-hide_banner',
        '-i',
        output,
        '-ss',
        String(at),
        '-frames:v',
        '1',
        '-threads',
        '1',
        '-y',
        path,
      ]);
    const stats = async (path: string, top: number, height: number) =>
      (
        await sharp(path)
          .extract({ left: 60, top, width: 960, height })
          .removeAlpha()
          .raw()
          .toBuffer()
      ).reduce((max, value) => Math.max(max, value), 0);
    assert.ok(
      (await stats(before, 1200, 600)) < 10,
      'no caption appears before its measured audio starts',
    );
    assert.ok(
      (await stats(during, 1200, 500)) > 200,
      'actual bright glyphs are rendered in the subtitle region',
    );
    assert.ok(
      (await stats(during, 0, 800)) < 10,
      'literal ASS-looking input cannot move text to the top',
    );
    assert.ok((await stats(during, 1800, 120)) < 10, 'bottom controls retain safe space');
    for (const left of [0, 984]) {
      const outside = await sharp(wide)
        .extract({ left, top: 1200, width: 96, height: 600 })
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.ok(
        outside.every((value) => value < 10),
        'even wide glyphs stay inside horizontal safe margins',
      );
    }
    assert.ok(
      (await stats(after, 1200, 600)) < 10,
      'no caption remains after its measured audio ends',
    );
    const decode = await encode([
      '-hide_banner',
      '-i',
      output,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-f',
      'null',
      '-',
    ]);
    assert.match(decode, /Audio: aac[^\n]*48000 Hz, stereo/);
    await writeFile(join(directory, 'decode.log'), decode);
    if (process.env.CREATOR_SUBTITLE_EVIDENCE_DIRECTORY) {
      const evidence = process.env.CREATOR_SUBTITLE_EVIDENCE_DIRECTORY;
      await mkdir(evidence, { recursive: true });
      for (const name of [
        'before.png',
        'during.png',
        'after.png',
        'subtitles.srt',
        'subtitles.ass',
        'subtitle-cues.json',
        'final.mp4',
      ])
        await copyFile(join(directory, name), join(evidence, name));
    }
  },
);
