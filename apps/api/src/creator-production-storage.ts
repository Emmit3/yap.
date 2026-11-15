import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { ApiError, StorageError } from './errors.js';

/** One in-process owner, bounded reads, and atomic serialized writes. Corruption is never reset. */
export async function productionStore<T>(file: string, schema: z.ZodType<T>, initial: T) {
  let state: T;
  try {
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('Storage limit exceeded.');
    state = schema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      state = schema.parse(initial);
    else
      throw new StorageError(
        'The saved production settings could not be read. Restore a valid data file.',
        { cause: error },
      );
  }
  let pending = Promise.resolve();
  return {
    async read(): Promise<T> {
      await pending;
      return structuredClone(state);
    },
    async mutate<R>(change: (next: T) => R | Promise<R>): Promise<R> {
      const operation = pending.then(async () => {
        const next = structuredClone(state);
        const result = await change(next);
        const validated = schema.parse(next);
        const content = JSON.stringify(validated, null, 2);
        if (Buffer.byteLength(content) > 8 * 1024 * 1024)
          throw new ApiError(
            409,
            'CREATOR_PRODUCTION_LIMIT',
            'Production settings storage is full.',
          );
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, content, { flag: 'wx', encoding: 'utf8' });
          await rename(temporary, file);
          state = validated;
          return structuredClone(result);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      });
      pending = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}

export interface ProductionMovieMetadata {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}
export async function productionMovieReceipt(
  path: string,
  expected: ProductionMovieMetadata,
  signal: AbortSignal,
  cwd: string,
) {
  const log = await runProductionFfmpeg(
    [
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      path,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-f',
      'null',
      '-',
    ],
    signal,
    cwd,
  );
  const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(log);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
  const dimensions = /Video:[^\r\n]*?,\s*([1-9]\d{1,4})x([1-9]\d{1,4})(?:\s|\[|,)/u.exec(log);
  const audio = log.split('Output #')[0]!.match(/Stream[^\r\n]*Audio:[^\r\n]*/gu) ?? [];
  if (
    !Number.isFinite(duration) ||
    Math.abs(duration - expected.duration) > 1 / 24 + 0.001 ||
    Number(dimensions?.[1]) !== expected.width ||
    Number(dimensions?.[2]) !== expected.height ||
    (expected.hasAudio ? audio.length !== 1 : audio.length !== 0)
  )
    throw new ApiError(
      502,
      'CREATOR_EDIT_VERIFICATION',
      'The rendered film does not match its approved duration, dimensions or sound.',
    );
  const bytes = (await stat(path)).size;
  if (bytes < 1 || bytes > 256 * 1024 * 1024)
    throw new ApiError(
      422,
      'CREATOR_EDIT_SIZE',
      'The edited film exceeds the download size limit.',
    );
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) {
    signal.throwIfAborted();
    hash.update(part);
  }
  return {
    bytes,
    sha256: hash.digest('hex'),
    duration,
    width: expected.width,
    height: expected.height,
    hasAudio: expected.hasAudio,
  };
}

export async function verifyProductionFile(
  path: string,
  receipt: { bytes: number; sha256: string },
): Promise<void> {
  try {
    if ((await stat(path)).size !== receipt.bytes) throw new Error('Size changed.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const part of createReadStream(path)) {
      bytes += part.length;
      if (bytes > receipt.bytes) throw new Error('Size changed while reading.');
      hash.update(part);
    }
    if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.sha256)
      throw new Error('Hash changed.');
  } catch {
    throw new ApiError(
      409,
      'CREATOR_PRODUCTION_INTEGRITY',
      'The saved media changed or is missing. Reload the finished film before continuing.',
    );
  }
}

const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
export async function runProductionFfmpeg(
  args: string[],
  signal: AbortSignal,
  cwd: string,
): Promise<string> {
  if (typeof binary !== 'string')
    throw new ApiError(
      503,
      'CREATOR_ENCODER_UNAVAILABLE',
      'The local video encoder is unavailable.',
    );
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-nostdin', ...args], {
      shell: false,
      windowsHide: true,
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '',
      finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(log);
    };
    const abort = () => {
      child.kill();
      finish(new ApiError(409, 'CREATOR_EDIT_CANCELED', 'The local render was canceled.'));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(
        new ApiError(
          503,
          'CREATOR_EDIT_TIMEOUT',
          'The local render took too long. Try a shorter edit.',
        ),
      );
    }, 180_000);
    child.stderr.on('data', (data: Buffer) => {
      log = (log + data.toString()).slice(-64_000);
    });
    child.on('error', () =>
      finish(
        new ApiError(
          503,
          'CREATOR_ENCODER_UNAVAILABLE',
          'The local video encoder could not start.',
        ),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) return finish();
      const failure = new ApiError(
        422,
        'CREATOR_EDIT_RENDER_FAILED',
        'The video could not be rendered. Check the edit timing and text before retrying.',
      );
      failure.cause = new Error(log);
      finish(failure);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
