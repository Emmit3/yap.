import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { CreatorClip } from '@yap/contracts/creator';
import { createFalCreatorVideoProvider } from '../src/creator-fal-provider.js';
import { creatorVideoConfigFromEnv } from '../src/creator-video-factory.js';

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'The office desk remains unchanged as sunlight moves across it.',
  camera: 'Slow push in.',
  lighting: 'Soft morning daylight.',
};
const image = () =>
  sharp({ create: { width: 864, height: 1536, channels: 3, background: '#a2a79b' } })
    .png()
    .toBuffer();
const bytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');

test('H3 Max uses its exact I2V and owner/app task paths, one approved image and no prompt expansion', async () => {
  const id = randomUUID();
  const task = `https://queue.fal.run/minimax/h3-max/requests/${id}`;
  const calls: { url: string; init?: RequestInit }[] = [];
  let saved = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.method === 'POST')
      return Response.json({
        request_id: id,
        response_url: task,
        status_url: `${task}/status`,
        cancel_url: `${task}/cancel`,
      });
    assert.equal(saved, true, 'paid request identity must be saved before polling');
    if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
    if (url === task)
      return Response.json({ video: { url: 'https://v3.fal.media/files/test/video.mp4' } });
    return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
  };
  const provider = createFalCreatorVideoProvider(
    { model: 'minimax-h3-max', apiKey: 'private-test-key', pollMs: 1 },
    fetcher,
  );
  await provider.generate({
    clip,
    image: await image(),
    signal: new AbortController().signal,
    onSubmitted: async (value) => {
      assert.equal(value, `fal:h3-max:${id}`);
      saved = true;
    },
  });
  assert.equal(calls[0]!.url, 'https://queue.fal.run/minimax/h3-max/image-to-video');
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.duration, 5);
  assert.equal(body.resolution, '768P');
  assert.equal(body.prompt_expansion_mode, 'disabled');
  assert.equal(body.generate_audio, undefined, 'H3 Max does not support this Seedance parameter');
  assert.equal(body.aspect_ratio, undefined, 'the selected portrait image sets the canvas');
  const metadata = await sharp(Buffer.from(body.image_url.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.width, 720);
  assert.equal(metadata.height, 1280);
  assert.equal((calls[0]!.init!.headers as Record<string, string>)['X-Fal-No-Retry'], '1');
  assert.equal(calls.at(-1)?.init?.headers, undefined, 'no key sent to CDN');
  assert.equal(provider.profile?.model, 'minimax-h3-max');
  assert.equal(
    provider.profile?.rateCentsPerSecond,
    10,
    'estimate covers regular pricing, not a temporary promotion',
  );
});

test('H3 Max rejects unanchored shots before dispatch or paid approval callback', async () => {
  let calls = 0;
  let approvals = 0;
  const provider = createFalCreatorVideoProvider(
    { model: 'minimax-h3-max', apiKey: 'private-test-key' },
    async () => {
      calls++;
      throw new Error('unexpected');
    },
  );
  await assert.rejects(
    provider.generate({
      clip,
      signal: new AbortController().signal,
      beforeSubmit: async () => {
        approvals++;
      },
      onSubmitted: async () => {},
    }),
    (error: unknown) =>
      Boolean(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'CREATOR_KEYFRAME_REQUIRED',
      ),
  );
  assert.equal(calls, 0);
  assert.equal(approvals, 0);
});

test('H3 Max cancellation cannot address a different model task', async () => {
  const urls: string[] = [];
  const provider = createFalCreatorVideoProvider(
    { model: 'minimax-h3-max', apiKey: 'private-test-key' },
    async (input) => {
      urls.push(String(input));
      return Response.json({ status: 'OK' });
    },
  );
  await assert.rejects(provider.cancel(`fal:seedance-1.5:${randomUUID()}`));
  const id = randomUUID();
  await provider.cancel(`fal:h3-max:${id}`);
  assert.deepEqual(urls, [`https://queue.fal.run/minimax/h3-max/requests/${id}/cancel`]);
});

test('model selection preserves the existing default and rejects incompatible provider/model settings', () => {
  assert.equal(creatorVideoConfigFromEnv({}).model, 'seedance-v1.5-pro');
  assert.equal(
    creatorVideoConfigFromEnv({
      CREATOR_VIDEO_PROVIDER: 'fal',
      CREATOR_VIDEO_MODEL: 'minimax-h3-max',
    }).model,
    'minimax-h3-max',
  );
  assert.throws(() =>
    creatorVideoConfigFromEnv({
      CREATOR_VIDEO_PROVIDER: 'runway',
      CREATOR_VIDEO_MODEL: 'minimax-h3-max',
    }),
  );
});
