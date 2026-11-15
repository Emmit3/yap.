import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CreatorApiError, createCreatorApi } from '../src/creator/api.js';

test('validation failures surface field-specific server limits for a saved answer', async () => {
  const transport: typeof fetch = async () =>
    Response.json(
      {
        error: {
          code: 'INVALID_CREATOR_INPUT',
          message: 'Check creation details.',
          details: [{ path: 'answers.productName', message: 'Use at most 120 characters.' }],
        },
      },
      { status: 400 },
    );
  await assert.rejects(
    createCreatorApi('', transport).get('film'),
    (error) =>
      error instanceof CreatorApiError &&
      error.status === 400 &&
      error.message.includes('answers.productName: Use at most 120 characters.'),
  );
});

test('the saved-film list is runtime validated rather than trusting malformed data', async () => {
  const empty: typeof fetch = async () => Response.json({ sessions: [] });
  assert.deepEqual(await createCreatorApi('', empty).list(), { sessions: [] });
  const malformed: typeof fetch = async () => Response.json({ sessions: [{ id: 'wrong' }] });
  await assert.rejects(
    createCreatorApi('', malformed).list(),
    (error) => error instanceof CreatorApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('network failures remain distinct from validation errors and pre-aborted requests do not send', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls += 1;
    throw new TypeError('offline');
  };
  const api = createCreatorApi('', transport);
  await assert.rejects(
    api.list(),
    (error) => error instanceof CreatorApiError && error.code === 'NETWORK_ERROR',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    api.list(controller.signal),
    (error) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(calls, 1);
});

test('clip previews and final downloads encode identifiers and keep the configured API origin', () => {
  const api = createCreatorApi('https://api.example/');
  assert.equal(
    api.outputUrl('film/id', 'job/id', true),
    'https://api.example/api/creator/sessions/film%2Fid/jobs/job%2Fid/video?download=1',
  );
  assert.equal(
    api.clipUrl('film', 'job', 'clip/id', 2),
    'https://api.example/api/creator/sessions/film/jobs/job/clips/clip%2Fid/video?attempt=2',
  );
});

test('saved prompt review is a read-only, encoded request with a runtime-validated response', async () => {
  const review = {
    planId: randomUUID(),
    workflowVersion: 3,
    hasBlockingIssues: false,
    clips: [
      {
        clipId: randomUUID(),
        compiledPrompt: 'A slow push toward the supplied product.',
        issues: [],
      },
    ],
  };
  let address = '';
  let method = '';
  const transport: typeof fetch = async (input, init) => {
    address = String(input);
    method = init?.method ?? 'GET';
    return Response.json(review);
  };
  assert.deepEqual(
    await createCreatorApi('https://api.example/', transport).reviewPlan('film/id'),
    review,
  );
  assert.equal(address, 'https://api.example/api/creator/sessions/film%2Fid/plan/review');
  assert.equal(method, 'GET');
  const malformed: typeof fetch = async () => Response.json({ ...review, clips: [] });
  await assert.rejects(
    createCreatorApi('', malformed).reviewPlan('film'),
    (error) => error instanceof CreatorApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('image library access is validated and generated files use encoded server-only URLs', async () => {
  let address = '';
  const transport: typeof fetch = async (input) => {
    address = String(input);
    return Response.json({ configured: false, variants: [], jobs: [] });
  };
  const api = createCreatorApi('https://api.example/', transport);
  assert.deepEqual(await api.images('film/id'), { configured: false, variants: [], jobs: [] });
  assert.equal(address, 'https://api.example/api/creator/sessions/film%2Fid/images');
  assert.equal(
    api.imageUrl('film/id', 'variant/id'),
    'https://api.example/api/creator/sessions/film%2Fid/images/variant%2Fid/file',
  );
  const broken: typeof fetch = async () =>
    Response.json({ configured: true, variants: [{ id: 'not-an-image' }], jobs: [] });
  await assert.rejects(
    createCreatorApi('', broken).images('film'),
    (error) => error instanceof CreatorApiError && error.code === 'INVALID_RESPONSE',
  );
});
