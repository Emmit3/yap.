import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import type { CreatorClip } from '@yap/contracts/creator';
import {
  createConfiguredCreatorVideoProvider,
  createConfiguredCreatorVideoProviders,
  creatorVideoProfileOptions,
  resolveCreatorVideoProvider,
} from '../src/creator-video-factory.js';
import { createCreatorVideoProvider } from '../src/creator-video-provider.js';
import { resolveOutputProfile } from '../src/creator-output-profiles.js';

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A ceramic cup on a studio table.',
  camera: 'Slow push in.',
  lighting: 'Window light.',
};

test('historical delivery stays portrait 1080p while native selections preserve their canvas', () => {
  assert.deepEqual(resolveOutputProfile({}), {
    id: 'portrait-1080',
    label: 'Portrait 1080p · resized from 720p',
    width: 1080,
    height: 1920,
    ratio: '720:1280',
    resized: true,
  });
  const portrait = resolveOutputProfile({ outputProfileId: 'portrait-720' });
  assert.deepEqual([portrait.width, portrait.height, portrait.resized], [720, 1280, false]);
  const landscape = resolveOutputProfile({ outputProfileId: 'landscape-720' });
  assert.deepEqual(
    [landscape.width, landscape.height, landscape.ratio, landscape.resized],
    [1280, 720, '1280:720', false],
  );
  portrait.width = 1;
  assert.equal(resolveOutputProfile({ outputProfileId: 'portrait-720' }).width, 720);
  assert.throws(() => resolveOutputProfile(JSON.parse('{"outputProfileId":"native-4k"}')), {
    code: 'CREATOR_OUTPUT_PROFILE',
  });
});

test('registry publishes explicit configured Runway profiles and an unavailable retired fal profile without calls', () => {
  let calls = 0;
  const registry = createConfiguredCreatorVideoProviders(
    { RUNWAYML_API_SECRET: 'fixture-key', FAL_KEY: 'unused-key' },
    async () => {
      calls++;
      throw new Error('No generation requested');
    },
  );
  const profiles = creatorVideoProfileOptions(registry);
  assert.equal(profiles.length, 5);
  assert.equal(profiles.filter((profile) => profile.configured).length, 4);
  const retired = profiles.find((profile) => profile.provider === 'fal')!;
  assert.equal(retired.retired, true);
  assert.equal(retired.configured, false);
  assert.match(retired.unavailableReason!, /removed.*November 11, 2026/);
  const turbo = profiles.find((profile) => profile.id === 'runway-gen4turbo-landscape')!;
  assert.deepEqual(
    [
      turbo.model,
      turbo.nativeWidth,
      turbo.nativeHeight,
      turbo.requiresImage,
      turbo.allowedSeconds,
      turbo.rateCentsPerSecond,
    ],
    ['gen4_turbo', 1280, 720, true, [5, 10], 5],
  );
  assert.equal(calls, 0);
});

test('saved shot selection is explicit and cannot fall back when unavailable or incompatible', () => {
  const registry = createConfiguredCreatorVideoProviders({ RUNWAYML_API_SECRET: 'fixture-key' });
  const fallback = createCreatorVideoProvider({ apiKey: 'fixture-key' });
  assert.equal(resolveCreatorVideoProvider(clip, fallback, registry), fallback);
  const selected = resolveCreatorVideoProvider(
    { ...clip, videoProfileId: 'runway-gen4.5-landscape' },
    fallback,
    registry,
  );
  assert.equal(selected.profile?.ratio, '1280:720');
  assert.throws(
    () =>
      resolveCreatorVideoProvider(
        { ...clip, videoProfileId: 'fal-seedance-v1.5-portrait' },
        fallback,
        registry,
      ),
    { code: 'CREATOR_MODEL_RETIRED' },
  );
  assert.throws(
    () =>
      resolveCreatorVideoProvider(
        { ...clip, videoProfileId: 'runway-gen4.5-landscape' },
        fallback,
        new Map(),
      ),
    { code: 'CREATOR_VIDEO_PROFILE' },
  );
  assert.throws(
    () =>
      resolveCreatorVideoProvider(
        { ...clip, videoProfileId: 'runway-gen4turbo-portrait' },
        fallback,
        registry,
      ),
    { code: 'CREATOR_IMAGE_REQUIRED' },
  );
  assert.throws(
    () =>
      resolveCreatorVideoProvider(
        { ...clip, seconds: 4, assetId: randomUUID(), videoProfileId: 'runway-gen4turbo-portrait' },
        fallback,
        registry,
      ),
    { code: 'CREATOR_CLIP_DURATION' },
  );
  const absent = createConfiguredCreatorVideoProviders({});
  assert.throws(
    () =>
      resolveCreatorVideoProvider(
        { ...clip, videoProfileId: 'runway-gen4.5-portrait' },
        fallback,
        absent,
      ),
    { code: 'CREATOR_VIDEO_NOT_CONFIGURED' },
  );
});

for (const ratio of ['720:1280', '1280:720'] as const)
  for (const model of ['gen4.5', 'gen4_turbo'] as const)
    test(`Runway ${model} sends the exact ${ratio} profile through one mocked HTTP task`, async () => {
      const taskId = randomUUID();
      const bodies: Record<string, unknown>[] = [];
      const order: string[] = [];
      const bytes = Buffer.from('fixture MP4 bytes');
      const provider = createCreatorVideoProvider(
        { apiKey: 'fixture-key', pollMs: 1, model, ratio },
        async (input, init) => {
          const url = String(input);
          if (init?.method === 'POST') {
            order.push('submit');
            bodies.push(JSON.parse(String(init.body)));
            assert.equal(url, 'https://api.dev.runwayml.com/v1/image_to_video');
            assert.equal(init.redirect, 'error');
            return Response.json({ id: taskId });
          }
          if (url.endsWith(`/tasks/${taskId}`)) {
            order.push('poll');
            return Response.json({
              id: taskId,
              status: 'SUCCEEDED',
              output: ['https://dnznrvs05pmza.cloudfront.net/fixture.mp4'],
            });
          }
          assert.equal(init?.headers, undefined);
          return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
        },
      );
      const image = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#444' },
      })
        .png()
        .toBuffer();
      assert.deepEqual(
        await provider.generate({
          clip,
          image,
          signal: new AbortController().signal,
          onSubmitted: async () => {
            order.push('persist');
          },
        }),
        bytes,
      );
      assert.deepEqual(order, ['submit', 'persist', 'poll']);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0]?.model, model);
      assert.equal(bodies[0]?.ratio, ratio);
      assert.equal(bodies[0]?.duration, 5);
      assert.match(String(bodies[0]?.promptImage), /^data:image\/jpeg;base64,/);
      assert.deepEqual(
        [provider.profile?.nativeWidth, provider.profile?.nativeHeight],
        ratio === '720:1280' ? [720, 1280] : [1280, 720],
      );
    });

test('Turbo rejects missing images and unsupported durations before preprocessing or submitting', async () => {
  let calls = 0;
  const provider = createCreatorVideoProvider(
    { apiKey: 'fixture-key', model: 'gen4_turbo' },
    async () => {
      calls++;
      throw new Error('Unexpected paid request');
    },
  );
  await assert.rejects(
    provider.generate({ clip, signal: new AbortController().signal, onSubmitted: async () => {} }),
    { code: 'CREATOR_IMAGE_REQUIRED' },
  );
  await assert.rejects(
    provider.generate({
      clip: { ...clip, seconds: 4 },
      image: Buffer.from('not decoded'),
      signal: new AbortController().signal,
      onSubmitted: async () => {},
    }),
    { code: 'CREATOR_CLIP_DURATION' },
  );
  assert.equal(calls, 0);
});

test('legacy configured-provider factory retains an explicit retired fal choice instead of using Runway', async () => {
  let calls = 0;
  const provider = createConfiguredCreatorVideoProvider(
    { provider: 'fal', apiKey: 'unused' },
    async () => {
      calls++;
      throw new Error('Unexpected paid request');
    },
  );
  assert.equal(provider.profile?.provider, 'fal');
  assert.equal(provider.configured, false);
  await assert.rejects(
    provider.generate({ clip, signal: new AbortController().signal, onSubmitted: async () => {} }),
    { code: 'CREATOR_MODEL_RETIRED' },
  );
  assert.equal(calls, 0);
});
