import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreatorRepository } from '../src/creator-repository.js';
import { createCreatorPaidRequests } from '../src/creator-paid-requests.js';
import { ApiError } from '../src/errors.js';
import type { CreatorResearch } from '@yap/contracts/creator';

const endpoint = 'https://api.openai.com/v1/responses';
const payload = (extra: object = {}): RequestInit => ({
  method: 'POST',
  headers: { Authorization: 'Bearer never-log-this', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-6-luna', input: 'Review a product shot.', ...extra }),
});
const output = () =>
  new Response(JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 1000 } }), {
    headers: { 'Content-Type': 'application/json' },
  });
async function fixture(t: { after(fn: () => Promise<void>): void }, limitCents = 3000) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-paid-requests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'creator.json');
  return { path, ledger: await CreatorRepository.open(path, { limitCents }) };
}
const emptyResearch: CreatorResearch = {
  summary: 'No provider evidence was collected.',
  productFacts: [],
  cinematography: '',
  sources: [],
  references: [],
  questions: [],
  limitations: [],
};

test('paid requests fail closed without a persistent ledger or a bounded model', async (t) => {
  let calls = 0;
  const gate = createCreatorPaidRequests(async () => {
    calls++;
    return output();
  });
  await assert.rejects(
    gate.fetch(endpoint, payload()),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_BUDGET_NOT_READY',
  );
  const { ledger } = await fixture(t);
  gate.attach(ledger);
  for (const extra of [{ model: 'unknown-expensive-model' }, { max_output_tokens: 8001 }])
    await assert.rejects(gate.fetch(endpoint, payload(extra)), ApiError);
  assert.equal(calls, 0);
  assert.equal((await ledger.budget()).availableCents, 3000);
});

test('the gate caps output and records a conservative rounded usage cost', async (t) => {
  const { ledger } = await fixture(t);
  let sent: Record<string, unknown> = {};
  const gate = createCreatorPaidRequests(async (_input, init) => {
    sent = JSON.parse(String(init?.body));
    return output();
  });
  gate.attach(ledger);
  const response = await gate.fetch(endpoint, payload());
  assert.equal(response.status, 200);
  assert.equal(sent.max_output_tokens, 2048);
  assert.equal((await response.json()).usage.input_tokens, 1000);
  const state = await ledger.budget();
  assert.equal(state.reservedCents, 0);
  assert.equal(state.chargedCents, 1);
  assert.equal(state.availableCents, 2999);
});

test('uncertain calls retain their hold across restart and block excess spend before POST', async (t) => {
  const { ledger, path } = await fixture(t, 50);
  let calls = 0;
  const gate = createCreatorPaidRequests(async () => {
    calls++;
    throw new Error('connection ended');
  });
  gate.attach(ledger);
  await assert.rejects(gate.fetch(endpoint, payload()), /connection ended/);
  const reopened = await CreatorRepository.open(path, { limitCents: 50 });
  assert.equal((await reopened.budget()).reservedCents, 50);
  gate.attach(reopened);
  await assert.rejects(
    gate.fetch(endpoint, payload()),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_BUDGET_EXCEEDED',
  );
  assert.equal(calls, 1);
});

test('a known authentication rejection releases its unused reservation', async (t) => {
  const { ledger } = await fixture(t);
  const gate = createCreatorPaidRequests(
    async () => new Response('not authorized', { status: 401 }),
  );
  gate.attach(ledger);
  assert.equal((await gate.fetch(endpoint, payload())).status, 401);
  assert.equal((await ledger.budget()).availableCents, 3000);
});

test('concurrent research branches each reserve before their provider dispatch', async (t) => {
  const { ledger } = await fixture(t);
  let calls = 0;
  const gate = createCreatorPaidRequests(async () => {
    calls++;
    return new Response('{}');
  });
  gate.attach(ledger);
  const analyze = gate.research(async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        gate.fetch('https://api.firecrawl.dev/v2/search', {
          method: 'POST',
          body: JSON.stringify({ query: 'product film', limit: 5 }),
        }),
      ),
    );
    return emptyResearch;
  }, true);
  await analyze({ mode: 'text', prompt: 'Matcha film', urls: [] }, []);
  assert.equal(calls, 5);
  assert.equal((await ledger.budget()).reservedCents, 50);
});

test('research that never reaches a paid provider releases its reservation', async (t) => {
  const { ledger } = await fixture(t);
  const gate = createCreatorPaidRequests(async () => {
    throw new Error('Unexpected network');
  });
  gate.attach(ledger);
  await gate.research(async () => emptyResearch, true)(
    { mode: 'text', prompt: 'Matcha', urls: [] },
    [],
  );
  assert.equal((await ledger.budget()).availableCents, 3000);
});

test('quote-reserved visual audits are not charged twice but still enforce model limits', async (t) => {
  const { ledger } = await fixture(t);
  let calls = 0;
  const gate = createCreatorPaidRequests(async () => {
    calls++;
    return output();
  });
  gate.attach(ledger);
  await ledger.reserve({
    idempotencyKey: 'approved-audit',
    category: 'vision',
    sourceId: 'clip',
    amountCents: 10,
  });
  await gate.prepaid(() => gate.fetch(endpoint, payload({ max_output_tokens: 2048 })));
  assert.equal((await ledger.budget()).reservedCents, 10);
  await assert.rejects(
    gate.prepaid(() => gate.fetch(endpoint, payload({ model: 'unpriced-model' }))),
    ApiError,
  );
  assert.equal(calls, 1);
});

test('legacy search also consumes the shared budget and cannot silently exceed it', async (t) => {
  const { ledger } = await fixture(t, 50);
  let calls = 0;
  const gate = createCreatorPaidRequests(async () => {
    calls++;
    return new Response('{}');
  });
  gate.attach(ledger);
  const request = { method: 'POST', body: JSON.stringify({ query: 'product film', limit: 40 }) };
  await gate.fetch('https://api.firecrawl.dev/v2/search', request);
  assert.equal((await ledger.budget()).reservedCents, 40);
  await assert.rejects(gate.fetch('https://api.firecrawl.dev/v2/search', request), ApiError);
  assert.equal(calls, 1);
});

test('paid built-in tools, multiple completions and unpriced X providers never dispatch', async (t) => {
  const { ledger } = await fixture(t);
  let calls = 0;
  const gate = createCreatorPaidRequests(async () => {
    calls++;
    return output();
  });
  gate.attach(ledger);
  for (const extra of [{ tools: [{ type: 'web_search' }] }, { n: 2 }])
    await assert.rejects(gate.fetch(endpoint, payload(extra)), ApiError);
  for (const host of ['api.x.ai', 'api.x.com', 'api.twitter.com'])
    await assert.rejects(gate.fetch(`https://${host}/v2/search`, payload()), ApiError);
  assert.equal(calls, 0);
  assert.equal((await ledger.budget()).availableCents, 3000);
});

test('known long-context usage includes premium rates and requests Standard service', async (t) => {
  const { ledger } = await fixture(t);
  const gate = createCreatorPaidRequests(async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).service_tier, 'default');
    return new Response(
      JSON.stringify({ usage: { input_tokens: 1_000_000, output_tokens: 8000 } }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
  gate.attach(ledger);
  await gate.fetch(endpoint, payload({ service_tier: 'priority', max_output_tokens: 8000 }));
  assert.equal((await ledger.budget()).chargedCents, 26);
});

test('a prepaid audit runs its final approval check after request preparation and covers one call', async (t) => {
  const { ledger } = await fixture(t);
  let calls = 0;
  const gate = createCreatorPaidRequests(async () => {
    calls++;
    return output();
  });
  gate.attach(ledger);
  await assert.rejects(
    gate.prepaid(
      () => gate.fetch(endpoint, payload()),
      async () => {
        throw new Error('Plan changed');
      },
    ),
    /Plan changed/,
  );
  assert.equal(calls, 0);
  await gate.prepaid(async () => {
    await gate.fetch(endpoint, payload());
    await assert.rejects(gate.fetch(endpoint, payload()), ApiError);
  });
  assert.equal(calls, 1);
});
