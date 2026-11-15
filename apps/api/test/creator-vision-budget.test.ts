import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import type { CreatorClip } from '@yap/contracts/creator';
import { createCreatorVisionAuditor, DEFAULT_CREATOR_VISION_MODEL } from '../src/creator-media.js';
import { ApiError } from '../src/errors.js';

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A ceramic cup.',
  camera: 'Slow push in.',
  lighting: 'Soft side light.',
};
const signal = () => new AbortController().signal;
const frame = () =>
  sharp({ create: { width: 360, height: 640, channels: 3, background: '#555' } })
    .jpeg()
    .toBuffer();
const result = { passed: true, summary: 'Only sampled frames were reviewed.', issues: [] };
function response(value: unknown = result, status = 'completed'): Response {
  return Response.json({
    status,
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  });
}
function isError(code: string) {
  return (error: unknown) => error instanceof ApiError && error.code === code;
}

test('vision review bounds output and image inputs while keeping model overrides compatible', async () => {
  const bytes = await frame();
  for (const model of [undefined, 'custom-vision-model']) {
    let calls = 0;
    const auditor = createCreatorVisionAuditor(
      { apiKey: 'fixture-only', ...(model ? { model } : {}) },
      async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, model ?? DEFAULT_CREATOR_VISION_MODEL);
        assert.equal(body.max_output_tokens, 2048);
        assert.equal(body.store, false);
        assert.deepEqual(body.reasoning, model ? undefined : { effort: 'none' });
        assert.equal(body.text.format.strict, true);
        const schema = body.text.format.schema;
        assert.equal(schema.additionalProperties, false);
        assert.deepEqual(schema.required, [
          'passed',
          'summary',
          'issues',
          'findings',
          'suggestedRevision',
        ]);
        assert.equal(schema.properties.summary.maxLength, 2000);
        assert.equal(schema.properties.issues.maxItems, 10);
        assert.equal(schema.properties.findings.maxItems, 10);
        assert.equal(schema.properties.findings.items.additionalProperties, false);
        assert.equal(schema.properties.suggestedRevision.anyOf[0].additionalProperties, false);
        const images = body.input[0].content.filter(
          (item: { type: string }) => item.type === 'input_image',
        );
        assert.equal(images.length, 3);
        for (const image of images) {
          const normalized = Buffer.from(image.image_url.split(',')[1], 'base64');
          const metadata = await sharp(normalized).metadata();
          assert.equal(metadata.format, 'jpeg');
          assert.ok(metadata.width! <= 640 && metadata.height! <= 640);
        }
        return response();
      },
    );
    assert.equal(
      (await auditor.audit(clip, [bytes, bytes, bytes], undefined, signal())).visionPassed,
      true,
    );
    assert.equal(calls, 1);
  }
});

test('oversized frames, references and prompts fail before a paid model call', async () => {
  const bytes = await frame();
  const wideFrame = await sharp({
    create: { width: 1025, height: 1, channels: 3, background: '#555' },
  })
    .png()
    .toBuffer();
  const wideReference = await sharp({
    create: { width: 20001, height: 1, channels: 3, background: '#555' },
  })
    .png()
    .toBuffer();
  let calls = 0;
  const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () => {
    calls++;
    return response();
  });
  const cases = [
    { frames: [bytes, bytes] },
    { frames: [Buffer.alloc(1024 * 1024 + 1), bytes, bytes] },
    { frames: [wideFrame, bytes, bytes] },
    { frames: [bytes, bytes, bytes], image: Buffer.alloc(10 * 1024 * 1024 + 1) },
    { frames: [bytes, bytes, bytes], image: wideReference },
    { frames: [bytes, bytes, bytes], clip: { ...clip, prompt: 'x'.repeat(1001) } },
  ];
  for (const input of cases)
    await assert.rejects(
      auditor.audit(input.clip ?? clip, input.frames, input.image, signal()),
      isError('CREATOR_AUDIT_INPUT_INVALID'),
    );
  assert.equal(calls, 0);
});

test('provider errors are sanitized and a failed audit never retries the model call', async () => {
  const bytes = await frame();
  const secret = 'fixture-secret-must-not-leak';
  for (const failure of ['transport', 'http', 'oversized'] as const) {
    let calls = 0;
    const auditor = createCreatorVisionAuditor({ apiKey: secret }, async () => {
      calls++;
      if (failure === 'transport') throw new Error(secret);
      if (failure === 'http') return Response.json({ error: secret }, { status: 401 });
      return new Response(secret.repeat(10000));
    });
    await assert.rejects(
      auditor.audit(clip, [bytes, bytes, bytes], undefined, signal()),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'CREATOR_AUDIT_PROVIDER_ERROR');
        assert.ok(!JSON.stringify(error).includes(secret));
        assert.ok(!String(error).includes(secret));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test('only a complete, exact audit result can pass review', async () => {
  const bytes = await frame();
  const invalid = [
    () => response({ ...result, approved: true }),
    () => response({ ...result, issues: Array.from({ length: 11 }, () => 'Issue') }),
    () => response({ ...result, summary: 'x'.repeat(2001) }),
    () =>
      response({
        ...result,
        findings: [
          {
            category: 'subject',
            severity: 'blocking',
            frameIndices: [3],
            observation: 'The shape changed.',
            suggestedFix: 'Preserve the silhouette.',
          },
        ],
      }),
    () => response({ ...result, suggestedRevision: { prompt: 'Incomplete correction.' } }),
    () => response(result, 'incomplete'),
    () => Response.json({ status: 'completed', output: 'not-an-array' }),
    () => new Response('not-json'),
  ];
  for (const makeResponse of invalid) {
    const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () =>
      makeResponse(),
    );
    await assert.rejects(
      auditor.audit(clip, [bytes, bytes, bytes], undefined, signal()),
      isError('CREATOR_AUDIT_INVALID'),
    );
  }
  const refusing = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () =>
    Response.json({
      status: 'completed',
      output: [{ content: [{ type: 'refusal', refusal: 'Provider-private explanation.' }] }],
    }),
  );
  await assert.rejects(
    refusing.audit(clip, [bytes, bytes, bytes], undefined, signal()),
    isError('CREATOR_AUDIT_REFUSED'),
  );
});

test('canceled review cannot submit a model request or expose an abort reason', async () => {
  const bytes = await frame();
  const controller = new AbortController();
  controller.abort(new Error('fixture-private-abort-reason'));
  let calls = 0;
  const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () => {
    calls++;
    return response();
  });
  await assert.rejects(
    auditor.audit(clip, [bytes, bytes, bytes], undefined, controller.signal),
    isError('CREATOR_CANCELED'),
  );
  assert.equal(calls, 0);
});
