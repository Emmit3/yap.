import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import type { CreatorImageSettings } from '@yap/contracts/creator-images';
import {
  createCreatorImageProvider,
  type CreatorImageProvider,
} from '../src/creator-image-provider.js';
import { ApiError } from '../src/errors.js';

const settings: CreatorImageSettings = {
  prompt: 'A handmade ceramic cup on a pale studio table.',
  model: 'gpt-image-2.6-flare',
  quality: 'medium',
  size: '864x1536',
  complexity: 'low',
};
const image = sharp({ create: { width: 864, height: 1536, channels: 3, background: '#b8c7b8' } })
  .png()
  .toBuffer();
const usage = {
  input_tokens: 50,
  output_tokens: 100,
  total_tokens: 150,
  input_tokens_details: { text_tokens: 20, image_tokens: 30 },
  output_tokens_details: { text_tokens: 0, image_tokens: 100 },
};
const request = (overrides: Partial<Parameters<CreatorImageProvider['generate']>[0]> = {}) => ({
  settings,
  signal: new AbortController().signal,
  beforeSubmit: async () => {},
  ...overrides,
});
async function response(extra: object = {}) {
  return Response.json({ data: [{ b64_json: (await image).toString('base64') }], usage, ...extra });
}

test('direct image generation pins the approved model and bounded settings, returning a canonical raster', async () => {
  let calls = 0;
  let checked = false;
  const provider = createCreatorImageProvider({ apiKey: 'private-test-key' }, async (url, init) => {
    calls++;
    assert.equal(checked, true, 'the final service check must precede the paid POST');
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.ok(init);
    assert.equal(init?.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer private-test-key');
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: settings.model,
      prompt: settings.prompt,
      n: 1,
      size: '864x1536',
      quality: 'medium',
      complexity: 'low',
      background: 'opaque',
      output_format: 'png',
    });
    return response();
  });
  assert.equal(provider.configured, true);
  const result = await provider.generate(
    request({
      beforeSubmit: async () => {
        checked = true;
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.mimeType, 'image/png');
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 864);
  assert.equal(metadata.height, 1536);
  assert.equal(metadata.hasAlpha, false);
  assert.deepEqual(result.usage, { textInputTokens: 20, imageInputTokens: 30, outputTokens: 100 });
});

test('edits send one normalized JPEG in the direct JSON images array and preserve Sunburst choice', async () => {
  const source = await sharp({
    create: { width: 2000, height: 1000, channels: 4, background: '#5555' },
  })
    .png()
    .toBuffer();
  let before = false;
  const provider = createCreatorImageProvider({ apiKey: 'test-only' }, async (url, init) => {
    assert.equal(before, true);
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-image-2.6-sunburst');
    assert.equal(body.images.length, 1);
    assert.match(body.images[0].image_url, /^data:image\/jpeg;base64,/);
    const normalized = Buffer.from(body.images[0].image_url.split(',')[1], 'base64');
    const metadata = await sharp(normalized).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 1536);
    assert.equal(metadata.height, 768);
    assert.equal(metadata.hasAlpha, false);
    for (const key of [
      'image',
      'image_urls',
      'input_fidelity',
      'response_format',
      'parentVariantId',
    ])
      assert.equal(key in body, false);
    return response();
  });
  await provider.generate(
    request({
      settings: { ...settings, model: 'gpt-image-2.6-sunburst', parentVariantId: randomUUID() },
      image: source,
      beforeSubmit: async () => {
        before = true;
      },
    }),
  );
});

test('invalid settings, absent selected references and malformed image bytes fail before submission', async () => {
  let calls = 0;
  let checks = 0;
  const provider = createCreatorImageProvider({ apiKey: 'test-only' }, async () => {
    calls++;
    return response();
  });
  const beforeSubmit = async () => {
    checks++;
  };
  await assert.rejects(
    Reflect.apply(provider.generate, provider, [
      { ...request({ beforeSubmit }), settings: { ...settings, model: 'unpriced-model' } },
    ]),
    ApiError,
  );
  await assert.rejects(
    provider.generate(
      request({ beforeSubmit, settings: { ...settings, sourceAssetId: randomUUID() } }),
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_IMAGE_INPUT_INVALID',
  );
  for (const source of [Buffer.from('not an image'), Buffer.alloc(10 * 1024 * 1024 + 1)])
    await assert.rejects(provider.generate(request({ image: source, beforeSubmit })), ApiError);
  assert.equal(calls, 0);
  assert.equal(checks, 0);
});

test('cancellation and a stale final approval check prevent the paid POST after preprocessing', async () => {
  let calls = 0;
  const provider = createCreatorImageProvider({ apiKey: 'test-only' }, async () => {
    calls++;
    return response();
  });
  const canceled = new AbortController();
  await assert.rejects(
    provider.generate(
      request({
        image: await image,
        signal: canceled.signal,
        beforeSubmit: async () => {
          canceled.abort('private cancellation detail');
        },
      }),
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_CANCELED',
  );
  const stale = new ApiError(409, 'CREATOR_APPROVAL_STALE', 'Review the current image quote.');
  await assert.rejects(
    provider.generate(
      request({
        beforeSubmit: async () => {
          throw stale;
        },
      }),
    ),
    (error: unknown) => error === stale,
  );
  const preCanceled = new AbortController();
  preCanceled.abort();
  await assert.rejects(provider.generate(request({ signal: preCanceled.signal })), ApiError);
  assert.equal(calls, 0);
});

test('provider rejection or uncertain network failure is sanitized and never replayed', async () => {
  const secret = 'must-never-appear-in-the-error';
  for (const mode of ['http', 'network'] as const) {
    let calls = 0;
    const provider = createCreatorImageProvider({ apiKey: secret }, async () => {
      calls++;
      if (mode === 'network') throw new Error(`Failure involving ${secret}`);
      return new Response(`Provider debug: ${secret}`, { status: 401 });
    });
    await assert.rejects(provider.generate(request()), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(
        error.code,
        mode === 'http' ? 'CREATOR_IMAGE_REJECTED' : 'CREATOR_IMAGE_PROVIDER_ERROR',
      );
      assert.equal(String(error).includes(secret), false);
      assert.equal('cause' in error, false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('deadline aborts an in-flight request without leaking provider details or retrying', async () => {
  let calls = 0;
  const provider = createCreatorImageProvider(
    { apiKey: 'test-only', timeoutMs: 30 },
    async (_url, init) => {
      calls++;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({})), 1000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('private provider abort message'));
          },
          { once: true },
        );
      });
    },
  );
  await assert.rejects(
    provider.generate(request()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'CREATOR_IMAGE_TIMEOUT' &&
      !error.message.includes('private'),
  );
  assert.equal(calls, 1);
});

test('invalid, extra, malformed and wrongly sized image outputs are rejected after one request', async () => {
  const valid = (await image).toString('base64');
  const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#333' } })
    .png()
    .toBuffer();
  const bodies = [
    { data: [{ url: 'https://example.com/untrusted.png' }] },
    { data: [] },
    { data: [{ b64_json: valid }, { b64_json: valid }] },
    { data: [{ b64_json: valid + '\n' }] },
    { data: [{ b64_json: 'AA=A' }] },
    {
      data: [
        { b64_json: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') },
      ],
    },
    { data: [{ b64_json: small.toString('base64') }] },
  ];
  for (const body of bodies) {
    let calls = 0;
    const provider = createCreatorImageProvider({ apiKey: 'test-only' }, async () => {
      calls++;
      return Response.json(body);
    });
    await assert.rejects(
      provider.generate(request()),
      (error: unknown) =>
        error instanceof ApiError && error.code === 'CREATOR_IMAGE_OUTPUT_INVALID',
    );
    assert.equal(calls, 1);
  }
});

test('oversized declared responses are stopped before accepting an image', async () => {
  const provider = createCreatorImageProvider(
    { apiKey: 'test-only' },
    async () =>
      new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(24 * 1024 * 1024 + 1),
        },
      }),
  );
  await assert.rejects(
    provider.generate(request()),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_IMAGE_PROVIDER_ERROR',
  );
});

test('missing or inconsistent usage keeps valid images but returns no unsafe billing counters', async () => {
  for (const invalidUsage of [
    undefined,
    { ...usage, output_tokens: -1 },
    { ...usage, total_tokens: 1 },
    { ...usage, input_tokens_details: { text_tokens: 40, image_tokens: 40 } },
    { ...usage, output_tokens_details: { text_tokens: 1, image_tokens: 1 } },
    { ...usage, input_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const provider = createCreatorImageProvider({ apiKey: 'test-only' }, () =>
      response({ usage: invalidUsage }),
    );
    const result = await provider.generate(request());
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.usage, undefined);
  }
});

test('missing credentials and invalid deadlines never attempt provider access', async () => {
  let calls = 0;
  const provider = createCreatorImageProvider({}, async () => {
    calls++;
    return response();
  });
  assert.equal(provider.configured, false);
  await assert.rejects(
    provider.generate(request()),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_IMAGE_NOT_CONFIGURED',
  );
  for (const timeoutMs of [0, -1, 0.5, 600001])
    assert.throws(() => createCreatorImageProvider({ apiKey: 'test-only', timeoutMs }), ApiError);
  assert.equal(calls, 0);
});
