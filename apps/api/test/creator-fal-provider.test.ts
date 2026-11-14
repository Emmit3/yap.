import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import type { CreatorClip } from '@yap/contracts/creator';
import { createFalCreatorVideoProvider } from '../src/creator-fal-provider.js';

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A ceramic cup rests on a studio plinth.',
  camera: 'Slow push in.',
  lighting: 'Soft side light.',
};
const root = 'https://queue.fal.run/fal-ai/bytedance/requests/';
const endpoint = 'https://queue.fal.run/fal-ai/bytedance/seedance/v1.5/pro/';
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const artifact = 'https://v3b.fal.media/files/fixture/output.mp4';
const signal = () => new AbortController().signal;
const receipt = (id: string) => `fal:seedance-1.5:${id}`;
function submission(id: string) {
  return {
    request_id: id,
    response_url: `${root}${id}`,
    status_url: `${root}${id}/status`,
    cancel_url: `${root}${id}/cancel`,
  };
}
type Call = { url: string; init?: RequestInit };
function harness(
  options: {
    id?: string;
    states?: string[];
    output?: string;
    download?: () => Response;
    onStatus?: () => void;
  } = {},
) {
  const id = options.id ?? randomUUID(),
    calls: Call[] = [];
  const states = [...(options.states ?? ['COMPLETED'])];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.method === 'POST') return Response.json(submission(id));
    if (url === `${root}${id}/status`) {
      options.onStatus?.();
      return Response.json({ status: states.shift() ?? 'COMPLETED' });
    }
    if (url === `${root}${id}`)
      return Response.json({ video: { url: options.output ?? artifact }, seed: 42 });
    if (url === `${root}${id}/cancel`) return Response.json({ status: 'OK' });
    if (url === artifact)
      return (
        options.download?.() ?? new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
      );
    throw new Error(`Unexpected request: ${url}`);
  };
  return {
    id,
    calls,
    fetcher,
    provider: createFalCreatorVideoProvider({ apiKey: 'test-key', pollMs: 1 }, fetcher),
  };
}

test('fal I2V normalizes own image onto a portrait canvas, submits silent720p, and persists before polling', async () => {
  let persisted = false;
  const h = harness({ onStatus: () => assert.equal(persisted, true) });
  const image = await sharp({
    create: { width: 80, height: 40, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  const result = await h.provider.generate({
    clip,
    image,
    signal: signal(),
    onSubmitted: async (id) => {
      assert.equal(id, receipt(h.id));
      persisted = true;
    },
  });
  assert.deepEqual(result, mp4);
  const first = h.calls[0];
  assert.equal(first?.url, `${endpoint}image-to-video`);
  const body = JSON.parse(String(first?.init?.body));
  assert.equal(body.duration, '5');
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(body.resolution, '720p');
  assert.equal(body.generate_audio, false);
  assert.equal(body.enable_safety_checker, true);
  assert.equal(body.num_frames, undefined);
  assert.match(body.prompt, /Camera: Slow push in/);
  assert.match(body.image_url, /^data:image\/jpeg;base64,/);
  const normalized = Buffer.from(body.image_url.split(',')[1], 'base64');
  const metadata = await sharp(normalized).metadata();
  assert.equal(metadata.width, 720);
  assert.equal(metadata.height, 1280);
  const { data, info } = await sharp(normalized).raw().toBuffer({ resolveWithObject: true });
  assert.ok((data[0] ?? 255) < 10, 'padding is black rather than generated content');
  const middle = (640 * info.width + 360) * info.channels;
  assert.ok((data[middle] ?? 0) > 240, 'original red image remains in the canvas center');
  assert.equal(h.calls.length, 4);
  assert.equal((first?.init?.headers as Record<string, string>).Authorization, 'Key test-key');
  assert.equal(h.calls[3]?.init?.headers, undefined, 'the CDN never receives the API key');
  for (const call of h.calls) assert.equal(call.init?.redirect, 'error');
  assert.deepEqual(h.provider.profile, {
    provider: 'fal',
    model: 'seedance-v1.5-pro',
    minSeconds: 4,
    maxSeconds: 10,
    rateCentsPerSecond: 5,
    priceSourceUrl: 'https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
    pricingCheckedAt: '2026-11-14',
  });
});

test('fal T2V uses its exact endpoint and waits through queue/running states without resubmitting', async () => {
  const h = harness({ states: ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'] });
  await h.provider.generate({ clip, signal: signal(), onSubmitted: async () => {} });
  assert.equal(h.calls[0]?.url, `${endpoint}text-to-video`);
  const body = JSON.parse(String(h.calls[0]?.init?.body));
  assert.equal(body.image_url, undefined);
  assert.equal(body.generate_audio, false);
  assert.equal(body.aspect_ratio, '9:16');
  assert.equal(h.calls.filter((c) => c.init?.method === 'POST').length, 1);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/status')).length, 3);
});

test('fal awaits the durable onSubmitted callback before any status/result request', async () => {
  const h = harness();
  let release!: () => void, submitted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saved = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const done = h.provider.generate({
    clip,
    signal: signal(),
    onSubmitted: async () => {
      submitted();
      await gate;
    },
  });
  await saved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  release();
  await done;
});

test('fal checks current approval after preparation and immediately before the paid POST', async (t) => {
  await t.test('rejected final approval check prevents submission', async () => {
    const h = harness();
    let checks = 0;
    const image = await sharp({
      create: { width: 80, height: 40, channels: 3, background: '#888' },
    })
      .png()
      .toBuffer();
    await assert.rejects(
      h.provider.generate({
        clip,
        image,
        signal: signal(),
        beforeSubmit: async () => {
          checks++;
          throw new Error('approval changed while preparing image');
        },
        onSubmitted: async () => assert.fail('no paid task should exist'),
      }),
    );
    assert.equal(checks, 1);
    assert.equal(h.calls.length, 0);
  });
  await t.test('pending final approval check blocks submission until it resolves', async () => {
    const h = harness();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const done = h.provider.generate({
      clip,
      signal: signal(),
      beforeSubmit: async () => {
        entered();
        await gate;
      },
      onSubmitted: async () => {},
    });
    await checking;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.length, 0);
    release();
    await done;
    assert.equal(h.calls.filter((call) => call.init?.method === 'POST').length, 1);
  });
  await t.test('abort while the approval check is pending prevents submission', async () => {
    const h = harness(),
      controller = new AbortController();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const done = h.provider.generate({
      clip,
      signal: controller.signal,
      beforeSubmit: async () => {
        entered();
        await gate;
      },
      onSubmitted: async () => assert.fail('no paid task should exist'),
    });
    await checking;
    controller.abort();
    release();
    await assert.rejects(done, { code: 'CREATOR_CANCELED' });
    assert.equal(h.calls.length, 0);
  });
});

test('fal failed submissions are never replayed and raw provider errors are not exposed', async (t) => {
  for (const failure of ['network', 'http', 'invalid-json'])
    await t.test(failure, async () => {
      let calls = 0;
      const provider = createFalCreatorVideoProvider(
        { apiKey: 'secret-key', pollMs: 1 },
        async () => {
          calls++;
          if (failure === 'network') throw new Error('secret-key private provider detail');
          if (failure === 'http')
            return Response.json({ detail: 'secret-key private provider detail' }, { status: 503 });
          return new Response('secret-key not-json');
        },
      );
      await assert.rejects(
        provider.generate({
          clip,
          signal: signal(),
          onSubmitted: async () => assert.fail('no known ID'),
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /secret-key|private provider detail/);
          return true;
        },
      );
      assert.equal(calls, 1);
    });
});

test('fal never follows credentialed operation URLs outside the exact task owner/app routes', async (t) => {
  for (const field of ['status_url', 'response_url', 'cancel_url'])
    for (const bad of [
      'https://evil.example/tasks/id',
      'https://queue.fal.run.evil.example/fal-ai/bytedance/requests/id',
      'https://queue.fal.run/fal-ai/other/requests/id',
      'https://test-key@queue.fal.run/fal-ai/bytedance/requests/id',
    ])
      await t.test(`${field}: ${bad}`, async () => {
        const id = randomUUID();
        let calls = 0,
          stored: string | undefined;
        const provider = createFalCreatorVideoProvider(
          { apiKey: 'test-key', pollMs: 1 },
          async () => {
            calls++;
            return Response.json({ ...submission(id), [field]: bad });
          },
        );
        await assert.rejects(
          provider.generate({
            clip,
            signal: signal(),
            onSubmitted: async (value) => {
              stored = value;
            },
          }),
          { code: 'CREATOR_VIDEO_URL_REJECTED' },
        );
        assert.equal(calls, 1);
        assert.equal(
          stored,
          receipt(id),
          'known paid ID remains recorded even when URLs are invalid',
        );
      });
});

test('fal rejects a mismatched request ID or missing operations before polling', async (t) => {
  for (const partial of [false, true])
    await t.test(String(partial), async () => {
      const id = randomUUID();
      let stored: string | undefined,
        calls = 0;
      const provider = createFalCreatorVideoProvider(
        { apiKey: 'test-key', pollMs: 1 },
        async () => {
          calls++;
          return Response.json(
            partial ? { request_id: id } : { ...submission(randomUUID()), request_id: id },
          );
        },
      );
      await assert.rejects(
        provider.generate({
          clip,
          signal: signal(),
          onSubmitted: async (value) => {
            stored = value;
          },
        }),
      );
      assert.equal(stored, receipt(id));
      assert.equal(calls, 1);
    });
});

test('fal artifact allowlist blocks SSRF, deceptive suffixes, credentials, ports and non-file routes', async (t) => {
  for (const url of [
    'https://127.0.0.1/files/output.mp4',
    'https://v3b.fal.media.evil.example/files/output.mp4',
    'https://evilfal.media/files/output.mp4',
    'http://v3b.fal.media/files/output.mp4',
    'https://key@v3b.fal.media/files/output.mp4',
    'https://v3b.fal.media:8443/files/output.mp4',
    'https://v3b.fal.media/private/output.mp4',
    'https://v3b.fal.media/files/../private/output.mp4',
    'https://v3b.fal.media/files/output.mp4#secret',
  ])
    await t.test(url, async () => {
      const h = harness({ output: url });
      await assert.rejects(
        h.provider.generate({ clip, signal: signal(), onSubmitted: async () => {} }),
        { code: 'CREATOR_VIDEO_URL_REJECTED' },
      );
      assert.equal(h.calls.length, 3);
    });
});

test('fal persists a self-contained task identity that a fresh adapter can cancel after restart', async () => {
  const first = harness();
  let stored = '';
  await first.provider.generate({
    clip,
    signal: signal(),
    onSubmitted: async (id) => {
      stored = id;
    },
  });
  const calls: Call[] = [];
  const fresh = createFalCreatorVideoProvider({ apiKey: 'test-key' }, async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ status: 'OK' });
  });
  await fresh.cancel(stored);
  assert.equal(calls[0]?.url, `${root}${first.id}/cancel`);
  assert.equal(calls[0]?.init?.method, 'PUT');
  assert.equal(calls[0]?.init?.signal?.aborted, false);
  assert.equal(calls[0]?.init?.redirect, 'error');
  await assert.rejects(fresh.cancel('https://evil.example/cancel'), {
    code: 'CREATOR_TASK_ID_INVALID',
  });
  assert.equal(calls.length, 1);
});

test('fal cancellation accepted while running remains unconfirmed and may still bill', async (t) => {
  for (const [status, body] of [
    [202, 'CANCELLATION_REQUESTED'],
    [400, 'ALREADY_COMPLETED'],
    [404, 'NOT_FOUND'],
  ] as const)
    await t.test(String(status), async () => {
      const provider = createFalCreatorVideoProvider({ apiKey: 'test-key' }, async () =>
        Response.json({ status: body }, { status }),
      );
      await assert.rejects(provider.cancel(receipt(randomUUID())), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /may continue billing/);
        return true;
      });
    });
});

test('fal abort after submission uses independent bounded cancellation without polling or a second POST', async () => {
  const h = harness();
  const controller = new AbortController();
  await assert.rejects(
    h.provider.generate({
      clip,
      signal: controller.signal,
      onSubmitted: async () => controller.abort(),
    }),
    { code: 'CREATOR_CANCELED' },
  );
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]?.init?.method, 'PUT');
  assert.equal(h.calls[1]?.init?.signal?.aborted, false);
  assert.equal(h.calls.filter((c) => c.init?.method === 'POST').length, 1);
});

test('fal persistence failure cancels the known task and never starts polling', async () => {
  const h = harness();
  await assert.rejects(
    h.provider.generate({
      clip,
      signal: signal(),
      onSubmitted: async () => {
        throw new Error('disk failed');
      },
    }),
  );
  assert.deepEqual(
    h.calls.map((c) => c.init?.method),
    ['POST', 'PUT'],
  );
});

test('fal provider deadline cancels a submitted task with a fresh cancellation signal', async () => {
  const h = harness();
  const provider = createFalCreatorVideoProvider(
    { apiKey: 'test-key', timeoutMs: 5, pollMs: 50 },
    h.fetcher,
  );
  await assert.rejects(provider.generate({ clip, signal: signal(), onSubmitted: async () => {} }), {
    code: 'CREATOR_VIDEO_TIMEOUT',
  });
  assert.deepEqual(
    h.calls.map((c) => c.init?.method),
    ['POST', 'PUT'],
  );
  assert.equal(h.calls[1]?.init?.signal?.aborted, false);
});

test('fal bounds JSON and MP4 bodies, including streaming data without content-length', async (t) => {
  await t.test('oversized JSON header', async () => {
    let calls = 0;
    const provider = createFalCreatorVideoProvider({ apiKey: 'test-key', pollMs: 1 }, async () => {
      calls++;
      return new Response('{}', { headers: { 'content-length': String(256 * 1024 + 1) } });
    });
    await assert.rejects(
      provider.generate({ clip, signal: signal(), onSubmitted: async () => {} }),
      { code: 'CREATOR_RESPONSE_LIMIT' },
    );
    assert.equal(calls, 1);
  });
  for (const streaming of [false, true])
    await t.test(streaming ? 'streaming MP4 limit' : 'MP4 content-length limit', async () => {
      let canceled = false;
      const chunk = new Uint8Array(1024 * 1024);
      const h = harness({
        download: () =>
          streaming
            ? new Response(
                new ReadableStream({
                  pull(controller) {
                    controller.enqueue(chunk);
                  },
                  cancel() {
                    canceled = true;
                  },
                }),
                { headers: { 'content-type': 'video/mp4' } },
              )
            : new Response(mp4, {
                headers: {
                  'content-type': 'video/mp4',
                  'content-length': String(100 * 1024 * 1024 + 1),
                },
              }),
      });
      await assert.rejects(
        h.provider.generate({ clip, signal: signal(), onSubmitted: async () => {} }),
        { code: 'CREATOR_RESPONSE_LIMIT' },
      );
      if (streaming) assert.equal(canceled, true);
    });
});

test('fal requires MP4 content type and container signature and never follows download redirects', async (t) => {
  for (const response of [
    () => new Response(mp4, { headers: { 'content-type': 'text/html' } }),
    () => new Response('<html>not an MP4</html>', { headers: { 'content-type': 'video/mp4' } }),
    () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/video.mp4' } }),
  ])
    await t.test(String(response), async () => {
      const h = harness({ download: response });
      await assert.rejects(
        h.provider.generate({ clip, signal: signal(), onSubmitted: async () => {} }),
      );
      assert.equal(h.calls.length, 4);
      assert.equal(h.calls[3]?.init?.redirect, 'error');
    });
});

test('fal validates missing configuration, image data, duration and prompt before paid submission', async (t) => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw new Error('unexpected paid request');
  };
  const absent = createFalCreatorVideoProvider({}, fetcher);
  assert.equal(absent.configured, false);
  await assert.rejects(
    absent.generate({ clip, signal: signal(), onSubmitted: async () => {} }),
    /Set FAL_KEY/,
  );
  const provider = createFalCreatorVideoProvider({ apiKey: 'test-key' }, fetcher);
  for (const seconds of [0, 3, 11, 5.5, Number.NaN])
    await t.test(`duration ${seconds}`, async () => {
      await assert.rejects(
        provider.generate({
          clip: { ...clip, seconds },
          signal: signal(),
          onSubmitted: async () => {},
        }),
        { code: 'CREATOR_CLIP_DURATION' },
      );
    });
  await assert.rejects(
    provider.generate({
      clip: { ...clip, prompt: 'x'.repeat(1001) },
      signal: signal(),
      onSubmitted: async () => {},
    }),
    { code: 'CREATOR_PROMPT_TOO_LONG' },
  );
  await assert.rejects(
    provider.generate({
      clip,
      image: Buffer.from('invalid'),
      signal: signal(),
      onSubmitted: async () => {},
    }),
    { code: 'CREATOR_IMAGE_INVALID' },
  );
  await assert.rejects(
    provider.generate({
      clip,
      image: Buffer.alloc(20 * 1024 * 1024 + 1),
      signal: signal(),
      onSubmitted: async () => {},
    }),
    { code: 'CREATOR_IMAGE_TOO_LARGE' },
  );
  assert.equal(calls, 0);
});
