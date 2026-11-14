import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { workflowSchema, type Workflow } from '@yap/contracts/workflow';
import { ApiError } from '../src/errors.js';
import { createWorkflowProvider, DEFAULT_WORKFLOW_MODEL } from '../src/workflow-provider.js';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1AAAAAASUVORK5CYII=',
  'base64',
);
const now = '2026-11-13T12:00:00.000Z';

function workflow(withImage = false): Workflow {
  return workflowSchema.parse({
    id: randomUUID(),
    version: 7,
    contentRevision: 3,
    title: 'Matcha morning',
    input: 'Make a promo for our neighborhood matcha shop using this product photo.',
    brief: {
      productName: 'Morning Matcha',
      productDescription: 'Our neighborhood matcha shop.',
      audience: 'Local matcha drinkers',
      keyBenefits: ['A quiet place to meet friends'],
      callToAction: 'Visit us this weekend.',
      imageDirection: 'Use the supplied drink photo.',
      platform: 'instagram',
      tone: 'conversational',
      duration: 30,
    },
    assets: withImage
      ? [
          {
            id: randomUUID(),
            filename: 'matcha.png',
            mimeType: 'image/png',
            bytes: image.byteLength,
            width: 1,
            height: 1,
            sha256: createHash('sha256').update(image).digest('hex'),
            description: 'A product photo supplied by the creator.',
            createdAt: now,
          },
        ]
      : [],
    messages: [],
    questions: [],
    script: null,
    scenes: null,
    approvals: { brief: null, script: null, scenes: null },
    createdAt: now,
    updatedAt: now,
  });
}

function completed(value: unknown): Response {
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
      ],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

const emptyBrief = {
  productName: null,
  productDescription: null,
  audience: null,
  keyBenefits: null,
  callToAction: null,
  imageDirection: null,
  tone: null,
  platform: null,
  duration: null,
};
const isCode = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;

test('guided provider needs no credentials or image transport and never silently calls AI', async () => {
  const source = workflow(true);
  const provider = createWorkflowProvider(
    { provider: 'guided' },
    {
      fetch: async () => {
        throw new Error('Unexpected remote call');
      },
      loadAsset: async () => {
        throw new Error('Unexpected image read');
      },
    },
  );
  assert.equal(provider.name, 'guided');
  const result = await provider.refine(source, { message: 'Focus on our matcha.' });
  assert.deepEqual(result.brief, {});
  assert.match(result.message, /review|claims/i);
});

test('selecting OpenAI without credentials fails explicitly rather than falling back', () => {
  assert.throws(
    () => createWorkflowProvider({ provider: 'openai' }),
    isCode('PROVIDER_NOT_CONFIGURED'),
  );
  assert.throws(
    () => createWorkflowProvider({ provider: 'openai', apiKey: 'test-key', timeoutMs: 0 }),
    isCode('PROVIDER_NOT_CONFIGURED'),
  );
});

test('refinement sends image bytes and strict structured output requirements, returning reviewable fields', async () => {
  const source = workflow(true);
  const snapshot = structuredClone(source);
  let imagesLoaded = 0;
  const provider = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-key' },
    {
      loadAsset: async (workflowId, asset) => {
        imagesLoaded++;
        assert.equal(workflowId, source.id);
        assert.equal(asset.id, source.assets[0]!.id);
        return { mimeType: 'image/png', data: image };
      },
      fetch: async (url, init) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, DEFAULT_WORKFLOW_MODEL);
        assert.equal(body.store, false);
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.text.format.strict, true);
        assert.equal(body.text.format.schema.additionalProperties, false);
        assert.deepEqual(body.text.format.schema.required.sort(), ['brief', 'message']);
        assert.match(body.input[0].content, /untrusted source material/);
        const supplied = body.input[1].content.find(
          (part: { type: string }) => part.type === 'input_image',
        );
        assert.equal(supplied.image_url, `data:image/png;base64,${image.toString('base64')}`);
        assert.ok(init?.signal);
        return completed({
          brief: { ...emptyBrief, productName: 'Morning Matcha' },
          message:
            'The image suggests a drink presentation; confirm its ingredients before using any ingredient claims.',
        });
      },
    },
  );
  const result = await provider.refine(source, { message: 'Highlight the presentation.' });
  assert.equal(imagesLoaded, 1);
  assert.deepEqual(result.brief, { productName: 'Morning Matcha' });
  assert.match(result.message, /confirm/);
  assert.deepEqual(source, snapshot);
});

test('script and scene drafts receive server-owned IDs and source provenance without self approval', async () => {
  const source = workflow();
  let scriptId = '';
  const provider = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-key', model: 'configured-vision-model' },
    {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'configured-vision-model');
        if (body.text.format.name === 'yap_script')
          return completed({
            hook: 'Your next matcha break.',
            segments: [
              { text: 'Your next matcha break.', seconds: 15 },
              { text: 'Meet friends at Morning Matcha.', seconds: 15 },
            ],
            caption: 'Visit us this weekend.',
          });
        assert.equal(body.text.format.name, 'yap_scenes');
        assert.equal(source.script?.id, scriptId);
        return completed({
          scenes: source.script!.segments.map((segment) => ({
            scriptSegmentId: segment.id,
            seconds: segment.seconds,
            visual: 'Film the counter and a prepared drink.',
            onScreenText: 'Morning Matcha',
            assetIds: [],
          })),
        });
      },
    },
  );
  source.script = await provider.script(source);
  scriptId = source.script.id;
  assert.equal(source.script.provider, 'openai');
  assert.equal(source.script.sourceRevision, source.contentRevision);
  assert.equal(new Set(source.script.segments.map((segment) => segment.id)).size, 2);
  const scenes = await provider.scenes(source);
  assert.equal(scenes.sourceScriptId, scriptId);
  assert.equal(scenes.provider, 'openai');
  assert.deepEqual(
    scenes.scenes.map((scene) => scene.scriptSegmentId),
    source.script.segments.map((segment) => segment.id),
  );
  assert.deepEqual(source.approvals, { brief: null, script: null, scenes: null });
});

test('queries return scoped existing evidence and current version without changing the workflow', async () => {
  const source = workflow();
  const snapshot = structuredClone(source);
  const provider = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-key' },
    {
      fetch: async () =>
        completed({
          answer: 'The supplied call to action is to visit this weekend.',
          evidence: [{ kind: 'brief', id: null, field: 'callToAction' }],
        }),
    },
  );
  const result = await provider.query(source, 'What should viewers do?');
  assert.equal(result.workflowVersion, source.version);
  assert.equal(result.provider, 'openai');
  assert.deepEqual(result.evidence, [{ kind: 'brief', field: 'callToAction' }]);
  assert.deepEqual(source, snapshot);
  const invented = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-key' },
    {
      fetch: async () =>
        completed({
          answer: 'An unsupported image reference.',
          evidence: [{ kind: 'asset', id: randomUUID(), field: null }],
        }),
    },
  );
  await assert.rejects(invented.query(source, 'Which image?'), isCode('PROVIDER_INVALID_OUTPUT'));
});

test('provider failures, refusals, incomplete responses, and invalid structures have safe errors', async () => {
  const cases: Array<{ response: () => Response; code: string }> = [
    {
      response: () => new Response('secret-provider-error-test-key', { status: 401 }),
      code: 'PROVIDER_UNAVAILABLE',
    },
    {
      response: () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [{ type: 'refusal', refusal: 'Sensitive upstream text' }],
              },
            ],
          }),
        ),
      code: 'PROVIDER_REFUSED',
    },
    {
      response: () => new Response(JSON.stringify({ status: 'incomplete', output: [] })),
      code: 'PROVIDER_INCOMPLETE',
    },
    { response: () => new Response('{invalid'), code: 'PROVIDER_INVALID_OUTPUT' },
    {
      response: () => completed({ hook: '', segments: [], caption: '' }),
      code: 'PROVIDER_INVALID_OUTPUT',
    },
    { response: () => new Response('x'.repeat(300 * 1024)), code: 'PROVIDER_INVALID_OUTPUT' },
  ];
  const source = workflow();
  const snapshot = structuredClone(source);
  for (const entry of cases) {
    const provider = createWorkflowProvider(
      { provider: 'openai', apiKey: 'test-key' },
      { fetch: async () => entry.response() },
    );
    await assert.rejects(provider.script(source), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, entry.code);
      assert.doesNotMatch(error.message, /test-key|secret-provider|Sensitive upstream/);
      return true;
    });
  }
  assert.deepEqual(source, snapshot);
});

test('network exceptions are sanitized and timeout/cancellation abort the underlying request', async () => {
  const source = workflow();
  const network = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-key' },
    {
      fetch: async () => {
        throw new Error('leaked-test-key');
      },
    },
  );
  await assert.rejects(network.script(source), isCode('PROVIDER_UNAVAILABLE'));
  let signalSeen: AbortSignal | undefined;
  const slow = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-key', timeoutMs: 10 },
    {
      fetch: async (_url, init) => {
        signalSeen = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => setTimeout(() => resolve(completed({})), 40));
      },
    },
  );
  await assert.rejects(slow.script(source), isCode('PROVIDER_TIMEOUT'));
  assert.equal(signalSeen?.aborted, true);
  const controller = new AbortController();
  let requested = false;
  const cancel = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-key' },
    {
      fetch: async () => {
        requested = true;
        controller.abort();
        return completed({});
      },
    },
  );
  await assert.rejects(cancel.script(source, controller.signal), isCode('REQUEST_CANCELED'));
  assert.equal(requested, true);
  const already = new AbortController();
  already.abort();
  requested = false;
  await assert.rejects(cancel.script(source, already.signal), isCode('REQUEST_CANCELED'));
  assert.equal(requested, false);
});

test('image limits and integrity failures stop before any remote transmission', async () => {
  const source = workflow(true);
  let requests = 0;
  const provider = createWorkflowProvider(
    { provider: 'openai', apiKey: 'test-key' },
    {
      fetch: async () => {
        requests++;
        return completed({});
      },
      loadAsset: async () => ({ mimeType: 'image/png', data: Buffer.alloc(image.byteLength) }),
    },
  );
  await assert.rejects(provider.script(source), isCode('ASSET_INTEGRITY_ERROR'));
  const large = workflow(true);
  large.assets = Array.from({ length: 3 }, () => ({
    ...large.assets[0]!,
    id: randomUUID(),
    bytes: 10 * 1024 * 1024,
  }));
  await assert.rejects(provider.script(large), isCode('PROVIDER_INPUT_TOO_LARGE'));
  assert.equal(requests, 0);
});
