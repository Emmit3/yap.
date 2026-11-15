import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { editDuration, type BrandInput, type EditBaseFilm } from '@yap/contracts/production';
import {
  createBrandService,
  productionFontName,
  renderBrandMovie,
  subtitleStyle,
} from '../src/creator-brand.js';
import { createEditService } from '../src/creator-edit.js';
import { productionMovieReceipt, runProductionFfmpeg } from '../src/creator-production-storage.js';
import {
  clampProductionText,
  productionTextAss,
  type ProductionTextLayer,
} from '../src/creator-production-text.js';

function requirePortableTextFilters(t: TestContext) {
  const original = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof original>) => {
    // Linux ffmpeg-static includes libass but omits drawtext. Preserve this
    // production capability boundary on machines whose binary has both filters.
    if (Array.isArray(args[1]) && args[1].some((arg) => /\bdrawtext=/u.test(arg)))
      throw new Error("No such filter: 'drawtext'");
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-brand-edit-'));
  t.after(async () => {
    const within = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function framePixels(directory: string, movie: string, seconds: number): Promise<Buffer> {
  const frame = join(directory, `text-frame-${seconds}.rgb`);
  await runProductionFfmpeg(
    [
      '-ss',
      String(seconds),
      '-i',
      movie,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-y',
      frame,
    ],
    new AbortController().signal,
    directory,
  );
  return readFile(frame);
}

test('portable text keeps literal creator copy and conservatively clamps it inside the frame', () => {
  const layer: ProductionTextLayer = {
      text: 'Literal %{n} <b> {\\alpha&HFF&}\\N\nNext',
      start: 0.125,
      end: 1.5,
      x: 320 * 0.95,
      y: 568 * 0.05,
      fontName: productionFontName('sans'),
      fontSize: 16,
      color: '#ffffff',
      alignment: 'center',
      box: { color: '#101010', opacity: 0.75, padding: 8 },
    },
    positioned = clampProductionText(layer, 320, 568),
    ass = productionTextAss(320, 568, [positioned]);
  assert.equal(positioned.alignment, 'top-left');
  assert.ok(positioned.x >= 16 && positioned.x < layer.x);
  assert.ok(positioned.y >= 16);
  const events = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(events.length, 1, 'newlines stay inside the one timed text event');
  assert.ok(
    events[0]!.includes('Literal %\\{n\\} <b> \\{\\\u2060alpha&HFF&\\}\\\u2060N\\NNext'),
    'all creator braces and backslashes stay literal ASS text',
  );
  assert.match(events[0]!, /0:00:00\.13,0:00:01\.50/u);
});
const brandInput = (name = 'Mori Drinks'): BrandInput => ({
  name,
  font: 'sans',
  inkColor: '#171717',
  paperColor: '#ffffff',
  accentColor: '#417b4a',
  endCard: { enabled: true, title: 'Fresh matcha', detail: 'Made with care.', seconds: 1 },
});

test('workspace brands persist optimistic revisions and retain verified normalized logos', async (t) => {
  const directory = await fixture(t),
    brand = await createBrandService(directory);
  const results = await Promise.allSettled([
    brand.update({ expectedVersion: 0, brand: brandInput() }),
    brand.update({ expectedVersion: 0, brand: brandInput('Other') }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await brand.get()).version, 1);
  const bytes = await sharp({
    create: { width: 1400, height: 700, channels: 4, background: '#3a7946' },
  })
    .png()
    .toBuffer();
  const uploaded = await brand.uploadLogo({ expectedVersion: 1, bytes });
  assert.equal(uploaded.logo?.width, 1024);
  assert.equal(uploaded.logo?.height, 512);
  const snapshot = await brand.snapshot();
  assert.equal(snapshot.version, 2);
  assert.match(subtitleStyle(snapshot).primaryColor, /^&H00[0-9A-F]{6}$/u);
  await brand.clearLogo({ expectedVersion: 2 });
  assert.equal((await brand.get()).logo, null);
  assert.deepEqual(
    await brand.verifySnapshot(snapshot),
    snapshot,
    'approved snapshots retain old verified logo bytes',
  );
  assert.equal((await (await createBrandService(directory)).get()).version, 3);
  await assert.rejects(brand.verifySnapshot({ ...snapshot, name: 'Changed' }), {
    code: 'CREATOR_BRAND_STALE',
  });
  await writeFile(brand.logoPath(snapshot.logo!), 'tampered');
  await assert.rejects(brand.verifySnapshot(snapshot), { code: 'CREATOR_PRODUCTION_INTEGRITY' });
  await assert.rejects(
    brand.uploadLogo({
      expectedVersion: 3,
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    }),
    { code: 'CREATOR_BRAND_LOGO_INVALID' },
  );
  await writeFile(join(directory, 'creator-brand.json'), '{broken');
  await assert.rejects(createBrandService(directory), /could not be read/u);
});

function baseFilm(): EditBaseFilm {
  return {
    jobId: randomUUID(),
    sha256: 'a'.repeat(64),
    bytes: 42,
    duration: 4,
    width: 320,
    height: 568,
    hasAudio: true,
    clips: [
      { id: randomUUID(), start: 0, end: 2 },
      { id: randomUUID(), start: 2, end: 4 },
    ],
  };
}
test('edit versions isolate sessions, validate trims, require review and never mutate generation receipts', async (t) => {
  const directory = await fixture(t),
    service = await createEditService(directory),
    sessionId = randomUUID(),
    base = baseFilm();
  const original = structuredClone(base),
    first = await service.create(sessionId, base);
  await assert.rejects(service.get(randomUUID(), first.id), { code: 'CREATOR_EDIT_NOT_FOUND' });
  const invalid = structuredClone(first.draft);
  invalid.segments[0]!.trimOut = 3;
  await assert.rejects(
    service.update(sessionId, first.id, { expectedVersion: 1, draft: invalid }),
    { code: 'CREATOR_EDIT_RANGE' },
  );
  const draft = structuredClone(first.draft);
  draft.segments.reverse();
  draft.segments[0]!.transition = 'dissolve';
  draft.segments[0]!.transitionSeconds = 0.5;
  const saved = await service.update(sessionId, first.id, { expectedVersion: 1, draft });
  assert.equal(saved.version, 2);
  assert.equal(editDuration(saved.draft), 3.5);
  assert.equal((await service.history(sessionId, first.id)).length, 2);
  await assert.rejects(service.update(sessionId, first.id, { expectedVersion: 1, draft }), {
    code: 'CREATOR_EDIT_VERSION_CONFLICT',
  });
  await assert.rejects(
    service.render(
      sessionId,
      first.id,
      { expectedVersion: 2, reviewed: false } as unknown as {
        expectedVersion: number;
        reviewed: true;
      },
      join(directory, 'absent.mp4'),
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    service.render(
      sessionId,
      first.id,
      { expectedVersion: 2, reviewed: true },
      join(directory, 'absent.mp4'),
      new AbortController().signal,
    ),
    { code: 'CREATOR_PRODUCTION_INTEGRITY' },
  );
  assert.deepEqual(base, original);
  assert.deepEqual(saved.base, original);
  assert.equal((await (await createEditService(directory)).get(sessionId, first.id)).version, 2);
});

async function sourceFilm(directory: string) {
  const source = join(directory, 'source.mp4'),
    signal = new AbortController().signal;
  await runProductionFfmpeg(
    [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x568:r=24:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x568:r=24:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=4',
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-t',
      '4',
      '-y',
      source,
    ],
    signal,
    directory,
  );
  return {
    source,
    receipt: await productionMovieReceipt(
      source,
      { duration: 4, width: 320, height: 568, hasAudio: true },
      signal,
      directory,
    ),
  };
}

for (const dissolveIndex of [0, 1])
  test(
    `real local edits reorder and trim video with matched audio dissolves, text, preview and integrity guards (dissolve at join ${dissolveIndex + 1})`,
    { timeout: 90_000 },
    async (t) => {
      requirePortableTextFilters(t);
      const directory = await fixture(t),
        { source, receipt } = await sourceFilm(directory),
        service = await createEditService(directory),
        sessionId = randomUUID();
      const base = { ...baseFilm(), ...receipt },
        first = await service.create(sessionId, base),
        draft = structuredClone(first.draft);
      draft.segments.reverse();
      draft.segments = [
        ...draft.segments,
        ...draft.segments.map((segment) => ({ ...segment, id: randomUUID() })),
      ];
      for (const segment of draft.segments) {
        segment.trimIn = 0.2;
        segment.trimOut = 1.8;
      }
      draft.segments[dissolveIndex]!.transition = 'dissolve';
      draft.segments[dissolveIndex]!.transitionSeconds = 0.3;
      draft.textLayers.push({
        id: randomUUID(),
        text: 'Literal %{n} <b>',
        start: 0,
        end: 1,
        x: 0.5,
        y: 0.2,
        fontSize: 48,
        color: '#ffffff',
      });
      const saved = await service.update(sessionId, first.id, { expectedVersion: 1, draft });
      assert.equal(saved.draft.segments[0]!.trimIn, 5 / 24);
      assert.equal(saved.draft.segments[0]!.trimOut, 43 / 24);
      assert.equal(saved.draft.segments[dissolveIndex]!.transitionSeconds, 7 / 24);
      const output = await service.render(
        sessionId,
        saved.id,
        { expectedVersion: saved.version, reviewed: true },
        source,
        new AbortController().signal,
      );
      assert.ok(Math.abs(output.duration - 145 / 24) <= 1 / 24);
      assert.equal(output.hasAudio, true);
      const verified = await service.verifyOutput(sessionId, saved.id, output.id);
      for (const [at, visible] of [
        [0.25, true],
        [1.25, false],
      ] as const) {
        const pixels = await framePixels(directory, verified.path, at);
        let white = 0;
        for (let index = 0; index < pixels.length; index += 3)
          if (pixels[index]! > 220 && pixels[index + 1]! > 220 && pixels[index + 2]! > 220) white++;
        assert.equal(white > 5, visible, 'creator text appears only during its saved time window');
      }
      for (const [at, expected] of [
        [0.1, 'blue'],
        [5.7, 'red'],
      ] as const) {
        const frame = join(directory, `frame-${expected}.raw`);
        await runProductionFfmpeg(
          [
            '-ss',
            String(at),
            '-i',
            verified.path,
            '-vf',
            'scale=1:1',
            '-frames:v',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            '-y',
            frame,
          ],
          new AbortController().signal,
          directory,
        );
        const pixel = await readFile(frame);
        assert.ok(
          expected === 'blue' ? pixel[2]! > pixel[0]! : pixel[0]! > pixel[2]!,
          'the rendered clip order matches the saved edit',
        );
      }
      await writeFile(verified.path, 'replaced');
      await assert.rejects(service.verifyOutput(sessionId, saved.id, output.id), {
        code: 'CREATOR_PRODUCTION_INTEGRITY',
      });
      const changed = await service.update(sessionId, saved.id, {
        expectedVersion: saved.version,
        draft: saved.draft,
      });
      assert.equal(changed.version, 3);
      await assert.rejects(service.verifyOutput(sessionId, saved.id, output.id), {
        code: 'CREATOR_EDIT_STALE',
      });
    },
  );

test(
  'real brand overlay keeps source duration and audio and renders a verified logo and end card',
  { timeout: 90_000 },
  async (t) => {
    requirePortableTextFilters(t);
    const directory = await fixture(t),
      { source, receipt } = await sourceFilm(directory),
      brands = await createBrandService(directory);
    await brands.update({ expectedVersion: 0, brand: brandInput() });
    await brands.uploadLogo({
      expectedVersion: 1,
      bytes: await sharp({ create: { width: 40, height: 40, channels: 4, background: '#17892d' } })
        .png()
        .toBuffer(),
    });
    const brand = await brands.snapshot(),
      work = join(directory, 'brand-work');
    await mkdir(work);
    const output = await renderBrandMovie({
      input: source,
      output: join(directory, 'branded.mp4'),
      directory: work,
      brand,
      logoPath: brands.logoPath(brand.logo!),
      signal: new AbortController().signal,
      metadata: receipt,
    });
    assert.equal(output.hasAudio, true);
    assert.ok(Math.abs(output.duration - 4) <= 1 / 24);
    assert.notEqual(output.sha256, receipt.sha256);
    const pixels = await framePixels(directory, join(directory, 'branded.mp4'), 3.5);
    let ink = 0;
    for (let y = 180; y < 260; y++)
      for (let x = 24; x < 300; x++) {
        const index = (y * 320 + x) * 3;
        if (pixels[index]! < 80 && pixels[index + 1]! < 80 && pixels[index + 2]! < 80) ink++;
      }
    assert.ok(ink > 10, 'the end card contains rendered title glyphs, not just its background');
  },
);
