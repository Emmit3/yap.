import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CreatorClip } from '@yap/contracts/creator';
import { createFalCreatorVideoProvider } from '../src/creator-fal-provider.js';

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'An original product shot.',
  camera: 'Still.',
  lighting: 'Soft.',
};

for (const apiKey of [undefined, 'fixture-key'])
  test(`retired fal generation is unavailable even ${apiKey ? 'with' : 'without'} a configured key`, async () => {
    let calls = 0,
      checks = 0,
      receipts = 0;
    const provider = createFalCreatorVideoProvider({ apiKey }, async () => {
      calls++;
      throw new Error('No request may reach a retired endpoint');
    });
    assert.equal(provider.configured, false);
    assert.equal(provider.profile?.retired, true);
    await assert.rejects(
      provider.generate({
        clip,
        signal: new AbortController().signal,
        beforeSubmit: async () => {
          checks++;
        },
        onSubmitted: async () => {
          receipts++;
        },
      }),
      { code: 'CREATOR_MODEL_RETIRED' },
    );
    assert.deepEqual([calls, checks, receipts], [0, 0, 0]);
  });

test('historical fal cancellation retains exact task identity and never starts generation', async () => {
  const id = randomUUID();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const provider = createFalCreatorVideoProvider({ apiKey: 'fixture-key' }, async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ status: 'OK' });
  });
  await provider.cancel(`fal:seedance-1.5:${id}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `https://queue.fal.run/fal-ai/bytedance/requests/${id}/cancel`);
  assert.equal(calls[0]?.init?.method, 'PUT');
  assert.equal(calls[0]?.init?.redirect, 'error');
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Key fixture-key');
});

test('historical cancellation rejects foreign task identities before any network request', async () => {
  let calls = 0;
  const provider = createFalCreatorVideoProvider({ apiKey: 'fixture-key' }, async () => {
    calls++;
    return Response.json({ status: 'OK' });
  });
  for (const id of ['not-a-task', `runway:${randomUUID()}`, 'fal:seedance-1.5:not-a-uuid'])
    await assert.rejects(provider.cancel(id), { code: 'CREATOR_TASK_ID_INVALID' });
  assert.equal(calls, 0);
});

test('uncertain historical cancellation stays conservative and hides provider details', async () => {
  const provider = createFalCreatorVideoProvider({ apiKey: 'private-fixture-key' }, async () =>
    Response.json(
      { status: 'CANCELLATION_REQUESTED', detail: 'private-fixture-key' },
      { status: 202 },
    ),
  );
  await assert.rejects(provider.cancel(`fal:seedance-1.5:${randomUUID()}`), (error) => {
    assert.ok(error instanceof Error);
    assert.equal('code' in error && error.code, 'CREATOR_CANCEL_UNCONFIRMED');
    assert.doesNotMatch(error.message, /private-fixture-key/);
    return true;
  });
});
