import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import {
  createCreatorImageAdapter,
  createCreatorImageService,
  type ApprovedImageOperation,
  type CreatorImageAdapter,
} from '../src/creator-images.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-storyboard-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(directory).startsWith('yap-storyboard-'));
    await rm(directory, { recursive: true, force: true });
  });
  const context = { sessionId: randomUUID(), sessionVersion: 1, workflowVersion: 1 };
  const bytes = await sharp({
    create: { width: 1024, height: 1536, channels: 3, background: '#bada55' },
  })
    .png()
    .toBuffer();
  const adapter: CreatorImageAdapter = {
    configured: true,
    model: 'gpt-image-2-2026-04-21',
    quote: () => ({
      model: 'gpt-image-2-2026-04-21',
      size: '1024x1536',
      quality: 'medium',
      maxCostCents: 10,
    }),
    generate: async () => ({ bytes }),
  };
  return { directory, context, bytes, adapter };
}
const input = { prompt: 'A ceramic cup in soft morning light.', purpose: 'storyboard' as const };
const approval = (
  context: { sessionVersion: number; workflowVersion: number },
  quoteId: string,
) => ({
  sessionVersion: context.sessionVersion,
  workflowVersion: context.workflowVersion,
  quoteId,
  requestId: randomUUID(),
  reviewed: true as const,
  costReviewed: true as const,
});

test('image adapter uses one fixed gated OpenAI request and bounded decoded output', async (t) => {
  const f = await fixture(t);
  let calls = 0,
    checked = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: 'gpt-image-2-2026-04-21',
      prompt: input.prompt,
      size: '1024x1536',
      quality: 'medium',
      n: 1,
      output_format: 'png',
    });
    return Response.json(
      {
        data: [{ b64_json: f.bytes.toString('base64') }],
        usage: { input_tokens: 30, output_tokens: 1367 },
      },
      { headers: { 'x-request-id': 'safe-provider-request' } },
    );
  };
  const adapter = createCreatorImageAdapter({ apiKey: 'fixture-not-a-real-key' }, fetcher);
  const service = createCreatorImageService(f.directory, {
    adapter,
    paid: async (_quote, _id, operation) => operation(),
  });
  const quote = await service.quote(f.context, input);
  const job = await service.generate(
    f.context,
    approval(f.context, quote.id),
    undefined,
    async () => {
      checked++;
    },
  );
  assert.equal(job.status, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(checked, 1);
  assert.equal(job.output?.provenance, 'generated_openai_api');
  assert.equal(
    (await service.verifyImage(f.context.sessionId, job.id)).bytes.length,
    f.bytes.length,
  );
});

test('saved image requests are idempotent, version-bound and isolated by creation', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const paid: ApprovedImageOperation = async (_quote, _id, operation) => {
    calls++;
    return operation();
  };
  const service = createCreatorImageService(f.directory, { adapter: f.adapter, paid });
  const quote = await service.quote(f.context, input),
    request = approval(f.context, quote.id);
  const jobs = await Promise.all([
    service.generate(f.context, request),
    service.generate(f.context, request),
  ]);
  assert.equal(calls, 1);
  assert.equal(jobs[0]!.id, jobs[1]!.id);
  await assert.rejects(
    () => service.generate(f.context, approval(f.context, quote.id)),
    /fresh quote/,
  );
  const reopened = createCreatorImageService(f.directory, { adapter: f.adapter, paid });
  assert.equal((await reopened.generate(f.context, request)).id, jobs[0]!.id);
  assert.equal(calls, 1);
  await assert.rejects(() => reopened.get(randomUUID(), jobs[0]!.id), /not in this creation/);
  const staleQuote = await reopened.quote(f.context, input);
  await assert.rejects(
    () =>
      reopened.generate({ ...f.context, sessionVersion: 2 }, approval(f.context, staleQuote.id)),
    /fresh image quote/,
  );
  assert.equal(calls, 1);
});

test('images require spending controls, explicit approval and bounded UTF-8 prompts', async (t) => {
  const f = await fixture(t),
    disabled = createCreatorImageService(f.directory, { adapter: f.adapter });
  await assert.rejects(() => disabled.quote(f.context, input), /spending controls/);
  const service = createCreatorImageService(f.directory, {
    adapter: f.adapter,
    paid: async (_q, _r, operation) => operation(),
  });
  await assert.rejects(
    () => service.quote(f.context, { ...input, prompt: 'é'.repeat(1100) }),
    /2000 UTF-8 bytes/,
  );
  const quote = await service.quote(f.context, input);
  await assert.rejects(() =>
    service.generate(f.context, { ...approval(f.context, quote.id), reviewed: false as never }),
  );
  assert.equal((await service.list(f.context.sessionId)).length, 0);
});

test('failed image calls never automatically retry and exact inputs allow only two manual attempts', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.adapter.generate = async () => {
    calls++;
    throw Error('Unknown network outcome');
  };
  const service = createCreatorImageService(f.directory, {
    adapter: f.adapter,
    paid: async (_q, _r, operation) => operation(),
  });
  for (let number = 1; number <= 2; number++) {
    const quote = await service.quote(f.context, input);
    const request = approval(f.context, quote.id);
    const job = await service.generate(f.context, request);
    assert.equal(job.status, 'failed');
    assert.equal(job.attempt, number);
    await service.generate(f.context, request);
    assert.equal(calls, number);
  }
  const quote = await service.quote(f.context, input);
  await assert.rejects(
    () => service.generate(f.context, approval(f.context, quote.id)),
    /both manual attempts/,
  );
  assert.equal(calls, 2);
});

test('generated frame lineage is hash-bound and tampered bytes cannot be served or selected', async (t) => {
  const f = await fixture(t),
    service = createCreatorImageService(f.directory, {
      adapter: f.adapter,
      paid: async (_q, _r, operation) => operation(),
    });
  const quote = await service.quote(f.context, input),
    frame = await service.generate(f.context, approval(f.context, quote.id));
  const next = await service.quote(f.context, { ...input, parentFrameId: frame.id });
  assert.equal(next.parentFrameSha256, frame.output!.sha256);
  const path = join(f.directory, f.context.sessionId, 'storyboards', `${frame.id}.png`),
    bytes = await readFile(path);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(path, bytes);
  await assert.rejects(() => service.verifyImage(f.context.sessionId, frame.id), /changed|missing/);
  assert.equal((await service.generate(f.context, approval(f.context, next.id))).status, 'failed');
});
