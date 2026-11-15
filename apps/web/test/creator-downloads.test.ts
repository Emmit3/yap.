import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  fetchCreatorVideo,
  fetchCreatorSubtitles,
  CreatorDownloadError,
  CREATOR_VIDEO_DOWNLOAD_TIMEOUT_MS,
} from '../src/creator/downloads.js';

const video = new TextEncoder().encode('00000018ftypisom-reviewed-video-fixture');
const expected = {
  bytes: video.byteLength,
  sha256: createHash('sha256').update(video).digest('hex'),
};
const response = (body: BodyInit | null = video, headers: HeadersInit = {}) =>
  new Response(body, { headers: { 'Content-Type': 'video/mp4', ...headers } });
const transport =
  (value: Response): typeof fetch =>
  async () =>
    value;

test('downloads exact UTF-8 SRT bytes independently of the MP4 and caption', async () => {
  const srt = new TextEncoder().encode('1\n00:00:01,200 --> 00:00:02,400\nCafé & matcha.\n');
  const receipt = { bytes: srt.length, sha256: createHash('sha256').update(srt).digest('hex') };
  const blob = await fetchCreatorSubtitles(
    '/subtitles.srt',
    receipt,
    undefined,
    transport(
      new Response(srt, {
        headers: {
          'Content-Type': 'application/x-subrip; charset=utf-8',
          'Content-Length': String(srt.length),
        },
      }),
    ),
  );
  assert.equal(blob.type, 'application/x-subrip;charset=utf-8');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), srt);
});

test('subtitle downloads reject replaced bytes, wrong content types and excessive receipts', async () => {
  const srt = new TextEncoder().encode('1\n00:00:00,000 --> 00:00:01,000\nHello.\n');
  const receipt = { bytes: srt.length, sha256: createHash('sha256').update(srt).digest('hex') };
  const replaced = srt.slice();
  replaced[replaced.length - 2] = 63;
  await assert.rejects(
    fetchCreatorSubtitles(
      '/srt',
      receipt,
      undefined,
      transport(
        new Response(replaced, {
          headers: { 'Content-Type': 'application/x-subrip' },
        }),
      ),
    ),
    (error: unknown) =>
      error instanceof CreatorDownloadError && error.code === 'DOWNLOAD_INTEGRITY',
  );
  await assert.rejects(
    fetchCreatorSubtitles('/srt', receipt, undefined, transport(response(srt))),
    (error: unknown) =>
      error instanceof CreatorDownloadError && error.code === 'DOWNLOAD_INVALID_TYPE',
  );
  let requested = false;
  await assert.rejects(
    fetchCreatorSubtitles('/srt', { ...receipt, bytes: 1024 * 1024 + 1 }, undefined, async () => {
      requested = true;
      return response(srt);
    }),
    (error: unknown) =>
      error instanceof CreatorDownloadError && error.code === 'DOWNLOAD_INVALID_RECEIPT',
  );
  assert.equal(requested, false);
});

test('downloads the complete reviewed MP4, verifies its receipt and removes the caller abort listener', async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(video.slice(0, 8));
      stream.enqueue(video.slice(8));
      stream.close();
    },
  });
  const blob = await fetchCreatorVideo(
    '/video',
    expected,
    controller.signal,
    async (_input, init) => {
      requestSignal = init?.signal;
      return response(body, {
        'Content-Type': 'video/mp4; codecs="avc1"',
        'Content-Length': String(expected.bytes),
      });
    },
  );
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'video/mp4');
  assert.equal(blob.size, expected.bytes);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), video);
  controller.abort();
  assert.equal(
    requestSignal?.aborted,
    false,
    'A completed download must detach the caller signal.',
  );
});

test('validated 404/409 API errors remain actionable and are never returned as video blobs', async () => {
  for (const status of [404, 409]) {
    const result = Response.json(
      {
        error: {
          code: status === 404 ? 'CREATOR_VIDEO_MISSING' : 'CREATOR_VIDEO_STALE',
          message: 'Reload the saved film.',
          details: [{ path: 'approval', message: 'Review the current version.' }],
        },
      },
      { status },
    );
    await assert.rejects(
      fetchCreatorVideo('/video', expected, undefined, transport(result)),
      (error: unknown) => {
        assert.ok(error instanceof CreatorDownloadError);
        assert.equal(error.status, status);
        assert.match(error.message, /Reload the saved film/);
        assert.match(error.message, /approval: Review the current version/);
        assert.equal(error.code, status === 404 ? 'CREATOR_VIDEO_MISSING' : 'CREATOR_VIDEO_STALE');
        return true;
      },
    );
  }
  await assert.rejects(
    fetchCreatorVideo(
      '/video',
      expected,
      undefined,
      transport(new Response('<html>Unexpected page</html>', { status: 502 })),
    ),
    (error: unknown) => {
      assert.ok(error instanceof CreatorDownloadError);
      assert.equal(error.code, 'DOWNLOAD_HTTP_ERROR');
      assert.ok(!error.message.includes('<html>'));
      return true;
    },
  );
});

test('rejects invalid receipts, non-MP4 bodies, partial responses and mismatched declared sizes', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return response();
  };
  for (const receipt of [
    { ...expected, bytes: 256 * 1024 * 1024 + 1 },
    { ...expected, bytes: 0 },
    { ...expected, sha256: 'invalid' },
  ])
    await assert.rejects(fetchCreatorVideo('/video', receipt, undefined, fetcher), {
      code: 'DOWNLOAD_INVALID_RECEIPT',
    });
  assert.equal(calls, 0);
  await assert.rejects(
    fetchCreatorVideo(
      '/video',
      expected,
      undefined,
      transport(Response.json({ error: 'This is not video' })),
    ),
    { code: 'DOWNLOAD_INVALID_TYPE' },
  );
  await assert.rejects(
    fetchCreatorVideo(
      '/video',
      expected,
      undefined,
      transport(new Response(video, { status: 206, headers: { 'Content-Type': 'video/mp4' } })),
    ),
    { code: 'DOWNLOAD_INVALID_TYPE' },
  );
  await assert.rejects(
    fetchCreatorVideo(
      '/video',
      expected,
      undefined,
      transport(response(video, { 'Content-Length': String(video.length + 1) })),
    ),
    { code: 'DOWNLOAD_SIZE_MISMATCH' },
  );
});

test('bounds streamed bytes and refuses truncated or corrupted content before creating a Blob', async () => {
  let canceled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(video);
      stream.enqueue(new Uint8Array([1]));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    fetchCreatorVideo('/video', expected, undefined, transport(response(oversized))),
    { code: 'DOWNLOAD_SIZE_LIMIT' },
  );
  assert.equal(canceled, true);
  await assert.rejects(
    fetchCreatorVideo('/video', expected, undefined, transport(response(video.slice(0, -1)))),
    { code: 'DOWNLOAD_TRUNCATED' },
  );
  assert.ok(globalThis.crypto?.subtle, 'The Node test runtime must expose Web Crypto.');
  await assert.rejects(
    fetchCreatorVideo(
      '/video',
      { ...expected, sha256: '0'.repeat(64) },
      undefined,
      transport(response()),
    ),
    { code: 'DOWNLOAD_INTEGRITY' },
  );
});

test('caller cancellation settles a stalled body and never saves a partial file', async () => {
  const controller = new AbortController();
  let reached!: () => void,
    canceled = false;
  const reading = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull() {
      reached();
      return new Promise<void>(() => {});
    },
    cancel() {
      canceled = true;
    },
  });
  const pending = fetchCreatorVideo(
    '/video',
    expected,
    controller.signal,
    transport(response(body)),
  );
  await reading;
  controller.abort();
  await assert.rejects(pending, {
    code: 'DOWNLOAD_CANCELED',
    message: 'Download canceled. No file was saved.',
  });
  assert.equal(canceled, true);
  let called = false;
  await assert.rejects(
    fetchCreatorVideo('/video', expected, controller.signal, async () => {
      called = true;
      return response();
    }),
    { code: 'DOWNLOAD_CANCELED' },
  );
  assert.equal(called, false);
});

test('the deadline settles a transport that ignores abort and the timer is cleared after success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = fetchCreatorVideo(
    '/video',
    expected,
    undefined,
    () => new Promise<Response>(() => {}),
  );
  const rejected = assert.rejects(pending, { code: 'DOWNLOAD_TIMEOUT' });
  t.mock.timers.tick(CREATOR_VIDEO_DOWNLOAD_TIMEOUT_MS);
  await rejected;
  let requestSignal: AbortSignal | null | undefined;
  await fetchCreatorVideo('/video', expected, undefined, async (_input, init) => {
    requestSignal = init?.signal;
    return response();
  });
  t.mock.timers.tick(CREATOR_VIDEO_DOWNLOAD_TIMEOUT_MS);
  assert.equal(requestSignal?.aborted, false);
});
