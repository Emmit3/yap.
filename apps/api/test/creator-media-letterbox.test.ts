import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import sharp from 'sharp';
import { assembleCreatorClips } from '../src/creator-media.js';

const run = promisify(execFile);
const encoder: string = createRequire(import.meta.url)('ffmpeg-static');
const signal = () => new AbortController().signal;

async function fixture(directory: string, filter: string) {
  const source = join(directory, 'source.mp4');
  await run(
    encoder,
    [
      '-hide_banner',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      filter,
      '-c:v',
      'libx264',
      '-crf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-y',
      source,
    ],
    { windowsHide: true },
  );
  return source;
}
async function frame(path: string, directory: string, at = 0.5) {
  const target = join(directory, `frame-${at}.png`);
  await run(
    encoder,
    ['-hide_banner', '-nostdin', '-ss', String(at), '-i', path, '-frames:v', '1', '-y', target],
    { windowsHide: true },
  );
  return sharp(await readFile(target))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}
function mean(data: Buffer, width: number, height: number, top: boolean) {
  let sum = 0,
    count = 0;
  for (let y = top ? 2 : height - 10; y < (top ? 10 : height - 2); y++)
    for (let x = 2; x < width - 2; x++) {
      const at = (y * width + x) * 3;
      sum += (data[at]! + data[at + 1]! + data[at + 2]!) / 3;
      count++;
    }
  return sum / count;
}
async function assemble(source: string, directory: string) {
  const output = join(directory, 'output.mp4');
  await assembleCreatorClips([source], output, directory, [2], signal(), undefined, false, {
    width: 180,
    height: 320,
  });
  return output;
}

test('assembly removes stable literal black letterboxing without changing the generated source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'creator-letterbox-'));
  try {
    const source = await fixture(directory, 'testsrc2=s=180x224:r=24:d=2,pad=180:320:0:48:black');
    const original = await readFile(source);
    const before = await frame(source, directory);
    assert.ok(mean(before.data, 180, 320, true) < 3);
    const result = await frame(await assemble(source, directory), directory);
    assert.ok(mean(result.data, 180, 320, true) > 30, 'the assembled top must contain the picture');
    assert.ok(
      mean(result.data, 180, 320, false) > 30,
      'the assembled bottom must contain the picture',
    );
    assert.deepEqual(await readFile(source), original, 'original artifact bytes are immutable');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('assembly preserves full-bleed color at both opposing edges', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'creator-fullbleed-'));
  try {
    const source = await fixture(
      directory,
      'color=c=0x203040:s=180x320:r=24:d=2,drawbox=x=0:y=0:w=iw:h=16:color=yellow:t=fill,drawbox=x=0:y=ih-16:w=iw:h=16:color=red:t=fill',
    );
    const result = await frame(await assemble(source, directory), directory);
    const top = (5 * 180 + 90) * 3,
      bottom = (315 * 180 + 90) * 3;
    assert.ok(result.data[top]! > 180 && result.data[top + 1]! > 180 && result.data[top + 2]! < 70);
    assert.ok(
      result.data[bottom]! > 180 && result.data[bottom + 1]! < 70 && result.data[bottom + 2]! < 70,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('assembly keeps dark full-frame footage even with a stable brighter central region', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'creator-night-'));
  try {
    const source = await fixture(
      directory,
      'color=black:s=180x320:r=24:d=2,drawbox=x=0:y=48:w=180:h=224:color=0x303030:t=fill',
    );
    const result = await frame(await assemble(source, directory), directory);
    assert.ok(mean(result.data, 180, 320, true) < 3);
    const center = (160 * 180 + 90) * 3;
    assert.ok(result.data[center]! > 40 && result.data[center]! < 60);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('assembly rejects one-sided margins and excessive picture removal', async () => {
  for (const filter of [
    'color=white:s=180x320:r=24:d=2,drawbox=x=0:y=0:w=iw:h=48:color=black:t=fill',
    'color=white:s=180x160:r=24:d=2,pad=180:320:0:80:black',
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'creator-unsafe-border-'));
    try {
      const result = await frame(
        await assemble(await fixture(directory, filter), directory),
        directory,
      );
      assert.ok(mean(result.data, 180, 320, true) < 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('assembly considers the whole clip and rejects temporary black margins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'creator-variable-border-'));
  try {
    const source = await fixture(
      directory,
      "color=white:s=180x320:r=24:d=2,drawbox=x=0:y=0:w=iw:h=48:color=black:t=fill:enable='lt(t,1.5)',drawbox=x=0:y=272:w=iw:h=48:color=black:t=fill:enable='lt(t,1.5)'",
    );
    const result = await frame(await assemble(source, directory), directory);
    assert.ok(mean(result.data, 180, 320, true) < 3, 'temporary margins must remain untouched');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
