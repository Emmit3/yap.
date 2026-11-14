import assert from 'node:assert/strict';
import test from 'node:test';
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
