import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import type { CreatorClip } from '@yap/contracts/creator';
import { createSeedance25CreatorVideoProvider } from '../src/creator-fal-seedance25.js';

const ROOT = 'https://queue.fal.run/bytedance/seedance-2.5';
const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A ceramic cup on a studio plinth.',
  camera: 'Slow push in.',
  lighting: 'Soft side light.',
};

test('Seedance 2.5 text requests use both native ratios, string duration and fixed queue routes', async () => {
  for (const ratio of ['720:1280', '1280:720'] as const) {
    const id = randomUUID(),
      order: string[] = [],
      calls: Array<{ url: string; init?: RequestInit }> = [];
    const bytes = Buffer.from('fixture MP4');
    const provider = createSeedance25CreatorVideoProvider(
      { apiKey: 'fixture-key', pollMs: 1, ratio },
      async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (init?.method === 'POST') {
          order.push('submit');
          return Response.json({
            request_id: id,
            status_url: 'https://127.0.0.1/private',
            response_url: 'https://127.0.0.1/private',
            cancel_url: 'https://127.0.0.1/private',
          });
        }
        if (url === `${ROOT}/requests/${id}/status`) {
          order.push('poll');
          return Response.json({ status: 'COMPLETED' });
        }
        if (url === `${ROOT}/requests/${id}`)
          return Response.json({ video: { url: 'https://v3b.fal.media/files/output.mp4' } });
        assert.equal(url, 'https://v3b.fal.media/files/output.mp4');
        assert.equal(init?.headers, undefined);
        return new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } });
      },
    );
    const output = await provider.generate({
      clip,
      signal: new AbortController().signal,
      beforeSubmit: async () => {
        order.push('approve');
      },
      onSubmitted: async (taskId) => {
        assert.equal(taskId, `fal:seedance-2.5:${id}`);
        order.push('persist');
      },
    });
    assert.deepEqual(output, bytes);
    assert.deepEqual(order, ['approve', 'submit', 'persist', 'poll']);
    assert.equal(calls.length, 4);
    assert.equal(calls[0]?.url, `${ROOT}/text-to-video`);
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(body.duration, '5');
    assert.equal(body.aspect_ratio, ratio === '720:1280' ? '9:16' : '16:9');
    assert.equal(body.resolution, '720p');
    assert.equal(body.codec, 'H264');
    assert.equal(body.bitrate_mode, 'standard');
    assert.equal(body.generate_audio, false);
    assert.equal(body.draft, false);
    assert.equal(body.image_url, undefined);
    assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Key fixture-key');
    assert.ok(calls.every(({ init }) => init?.redirect === 'error'));
    assert.equal(provider.profile?.rateCentsPerSecond, 50);
  }
});

test('Seedance image input fills the exact native canvas without padding and is reapproved before a paid POST', async () => {
  const image = await sharp({
    create: { width: 160, height: 25, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const original = Buffer.from(image);
  for (const ratio of ['720:1280', '1280:720'] as const) {
    const id = randomUUID();
    let paidBody: Record<string, unknown> | undefined;
    const provider = createSeedance25CreatorVideoProvider(
      { apiKey: 'fixture-key', pollMs: 1, ratio },
      async (input, init) => {
        if (init?.method === 'POST') {
          assert.equal(String(input), `${ROOT}/image-to-video`);
          paidBody = JSON.parse(String(init.body));
          return Response.json({ request_id: id });
        }
        if (String(input).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        if (String(input) === `${ROOT}/requests/${id}`)
          return Response.json({
            video: { url: 'https://storage.googleapis.com/falserverless/output.mp4' },
          });
        return new Response('fixture', { headers: { 'Content-Type': 'video/mp4' } });
      },
    );
    await provider.generate({
      clip,
      image,
      signal: new AbortController().signal,
      beforeSubmit: async () => {
        assert.equal(paidBody, undefined);
      },
      onSubmitted: async () => {},
    });
    assert.equal(paidBody?.aspect_ratio, 'auto');
    const dataUri = String(paidBody?.image_url);
    assert.match(dataUri, /^data:image\/jpeg;base64,/);
    assert.ok(Buffer.byteLength(dataUri) <= 5 * 1024 * 1024);
    const normalized = Buffer.from(dataUri.split(',')[1]!, 'base64');
    const metadata = await sharp(normalized).metadata();
    assert.equal(metadata.width, ratio === '720:1280' ? 720 : 1280);
    assert.equal(metadata.height, ratio === '720:1280' ? 1280 : 720);
    const stats = await sharp(normalized).stats();
    assert.ok(
      stats.channels.every((channel) => channel.min > 240),
      'a solid wide reference must fill every output pixel without invented black bars',
    );
    assert.deepEqual(image, original, 'the original reference bytes stay unchanged');
  }
  let calls = 0;
  const provider = createSeedance25CreatorVideoProvider({ apiKey: 'fixture-key' }, async () => {
    calls++;
    throw new Error('must not submit');
  });
  const approvalError = new Error('Approval revision changed');
  await assert.rejects(
    provider.generate({
      clip,
      image,
      signal: new AbortController().signal,
      beforeSubmit: async () => {
        throw approvalError;
      },
      onSubmitted: async () => {},
    }),
    (error) => error === approvalError,
  );
  assert.equal(calls, 0);
});

test('Seedance artifacts reject foreign hosts, foreign buckets and oversized downloads without credentials', async () => {
  for (const artifact of [
    'https://127.0.0.1/internal.mp4',
    'http://fal.media/output.mp4',
    'https://fal.media.evil.example/output.mp4',
    'https://storage.googleapis.com/other-bucket/output.mp4',
    'https://fal.media:444/output.mp4',
    'https://user:password@fal.media/output.mp4',
    'https://v3b.fal.media/oversized.mp4',
  ]) {
    const id = randomUUID();
    let downloads = 0;
    const provider = createSeedance25CreatorVideoProvider(
      { apiKey: 'fixture-key', pollMs: 1 },
      async (input, init) => {
        if (init?.method === 'POST') return Response.json({ request_id: id });
        if (String(input).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        if (String(input) === `${ROOT}/requests/${id}`)
          return Response.json({ video: { url: artifact } });
        downloads++;
        assert.equal(init?.headers, undefined);
        assert.equal(init?.redirect, 'error');
        return new Response('fixture', {
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(101 * 1024 * 1024) },
        });
      },
    );
    const oversized = artifact.includes('oversized');
    await assert.rejects(
      provider.generate({
        clip,
        signal: new AbortController().signal,
        onSubmitted: async () => {},
      }),
      { code: oversized ? 'CREATOR_RESPONSE_LIMIT' : 'CREATOR_VIDEO_URL_REJECTED' },
    );
    assert.equal(downloads, oversized ? 1 : 0);
  }
});

test('Seedance cancellation and deadlines never replay an uncertain paid submission', async () => {
  const id = randomUUID(),
    controller = new AbortController();
  const abortError = new Error('User stopped generation');
  let submits = 0,
    cancels = 0;
  const provider = createSeedance25CreatorVideoProvider(
    { apiKey: 'fixture-key', pollMs: 1 },
    async (input, init) => {
      if (init?.method === 'PUT') {
        cancels++;
        assert.equal(String(input), `${ROOT}/requests/${id}/cancel`);
        return Response.json({ status: 'CANCELLATION_REQUESTED' }, { status: 202 });
      }
      submits++;
      return Response.json({ request_id: id });
    },
  );
  await assert.rejects(
    provider.generate({
      clip,
      signal: controller.signal,
      onSubmitted: async () => controller.abort(abortError),
    }),
    (error) => error instanceof Error && 'cause' in error && error.cause === abortError,
  );
  assert.deepEqual([submits, cancels], [1, 1]);
  await assert.rejects(provider.cancel(`fal:seedance-1.5:${id}`), {
    code: 'CREATOR_TASK_ID_INVALID',
  });
  const deadline = createSeedance25CreatorVideoProvider(
    { apiKey: 'fixture-key', timeoutMs: 20, pollMs: 1 },
    async (_input, init) => {
      submits++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    },
  );
  // Keep the test event loop alive while AbortSignal.timeout's timer is unreferenced.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(
      deadline.generate({
        clip,
        signal: new AbortController().signal,
        onSubmitted: async () => {},
      }),
      { name: 'TimeoutError' },
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(submits, 2, 'one submission per attempt, with no timeout retry');
});

test('Seedance content-policy rejections explain the next action without exposing provider details or replaying work', async () => {
  const sensitiveDetail = {
    type: 'content_policy_violation',
    loc: ['body', 'image_url'],
    msg: 'Private provider response with provider-secret',
    input: 'https://private.example/reference.jpg?key=provider-secret',
    ctx: { reason: 'partner_validation_failed' },
  };
  for (const detail of [sensitiveDetail, [sensitiveDetail]]) {
    const id = randomUUID();
    let submissions = 0;
    const provider = createSeedance25CreatorVideoProvider(
      { apiKey: 'provider-secret', pollMs: 1 },
      async (input, init) => {
        if (init?.method === 'POST') {
          submissions++;
          return Response.json({ request_id: id });
        }
        if (String(input).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        assert.equal(String(input), `${ROOT}/requests/${id}`);
        return Response.json({ detail }, { status: 422 });
      },
    );
    await assert.rejects(
      provider.generate({
        clip,
        signal: new AbortController().signal,
        onSubmitted: async () => {},
      }),
      {
        status: 422,
        code: 'CREATOR_VIDEO_CONTENT_REJECTED',
        message:
          'The video provider rejected this content. Choose a different suitable reference photo and review the shot before trying again.',
      },
    );
    assert.equal(submissions, 1, 'a rejected accepted task must never repeat its paid POST');
  }
});

test('Seedance content error classification preserves busy and all unrecognized provider errors', async () => {
  for (const [status, body] of [
    [429, { detail: { type: 'content_policy_violation' } }],
    [500, { detail: { type: 'content_policy_violation' } }],
    [422, { detail: { type: 'validation_error', msg: 'content_policy_violation' } }],
    [422, { detail: 'content_policy_violation' }],
    [422, 'not JSON'],
  ] as const) {
    let submissions = 0;
    const provider = createSeedance25CreatorVideoProvider({ apiKey: 'fixture-key' }, async () => {
      submissions++;
      return typeof body === 'string'
        ? new Response(body, { status })
        : Response.json(body, { status });
    });
    await assert.rejects(
      provider.generate({
        clip,
        signal: new AbortController().signal,
        onSubmitted: async () => {},
      }),
      {
        status: status === 429 ? 429 : 502,
        code: 'CREATOR_VIDEO_PROVIDER_ERROR',
        message:
          status === 429
            ? 'The video provider is busy. No paid request was automatically repeated.'
            : 'The video provider rejected the request. Check its configuration, balance and content restrictions.',
      },
    );
    assert.equal(submissions, 1);
  }
});
