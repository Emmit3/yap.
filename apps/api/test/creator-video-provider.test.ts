import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import type { CreatorClip } from '@yap/contracts/creator';
import { createCreatorVideoProvider } from '../src/creator-video-provider.js';

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A ceramic cup rotates slowly on a studio plinth.',
  camera: 'Slow push in.',
  lighting: 'Soft side light.',
};
test('Runway adapter submits once, records task before polling, uses the current REST API and persists artifact bytes', async () => {
  const id = randomUUID(),
    calls: Array<{ url: string; init?: RequestInit }> = [],
    order: string[] = [];
  const bytes = Buffer.from('fixture MP4 bytes');
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/image_to_video')) {
      order.push('submit');
      return Response.json({ id });
    }
    if (url.endsWith(`/tasks/${id}`)) {
      order.push('poll');
      return Response.json({
        id,
        status: 'SUCCEEDED',
        output: ['https://dnznrvs05pmza.cloudfront.net/output.mp4?_jwt=fixture'],
      });
    }
    return new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } });
  };
  const provider = createCreatorVideoProvider({ apiKey: 'test-key', pollMs: 1 }, fetcher),
    image = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#999' } })
      .png()
      .toBuffer();
  const result = await provider.generate({
    clip,
    image,
    signal: new AbortController().signal,
    onSubmitted: async (taskId) => {
      assert.equal(taskId, id);
      order.push('persist');
    },
  });
  assert.deepEqual(result, bytes);
  assert.deepEqual(order, ['submit', 'persist', 'poll']);
  const request = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(request.model, 'gen4.5');
  assert.equal(request.duration, 5);
  assert.equal(request.ratio, '720:1280');
  assert.match(request.promptImage, /^data:image\/jpeg;base64,/);
  assert.equal(
    (calls[0]?.init?.headers as Record<string, string>)['X-Runway-Version'],
    '2024-11-06',
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.init?.headers, undefined);
});
test('unknown submit failures are never replayed and an untrusted artifact host is never fetched', async () => {
  let submits = 0;
  const first = createCreatorVideoProvider({ apiKey: 'test-key', pollMs: 1 }, async () => {
    submits++;
    throw new Error('Network outcome unknown');
  });
  await assert.rejects(
    first.generate({ clip, signal: new AbortController().signal, onSubmitted: async () => {} }),
  );
  assert.equal(submits, 1);
  const id = randomUUID();
  let calls = 0;
  const second = createCreatorVideoProvider({ apiKey: 'test-key', pollMs: 1 }, async (input) => {
    calls++;
    return String(input).endsWith('/text_to_video')
      ? Response.json({ id })
      : Response.json({ id, status: 'SUCCEEDED', output: ['https://127.0.0.1/internal.mp4'] });
  });
  await assert.rejects(
    second.generate({ clip, signal: new AbortController().signal, onSubmitted: async () => {} }),
    { code: 'CREATOR_VIDEO_URL_REJECTED' },
  );
  assert.equal(calls, 2);
});
test('canceling after submission requests best effort provider cancellation without resubmitting', async () => {
  const id = randomUUID(),
    controller = new AbortController();
  let submits = 0,
    deletes = 0;
  const provider = createCreatorVideoProvider(
    { apiKey: 'test-key', pollMs: 1 },
    async (_input, init) => {
      if (init?.method === 'DELETE') {
        deletes++;
        return new Response(null, { status: 204 });
      }
      submits++;
      return Response.json({ id });
    },
  );
  await assert.rejects(
    provider.generate({
      clip,
      signal: controller.signal,
      onSubmitted: async () => controller.abort(),
    }),
  );
  assert.equal(submits, 1);
  assert.equal(deletes, 1);
});
