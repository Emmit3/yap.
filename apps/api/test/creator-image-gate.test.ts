import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  budgetSnapshot,
  reserveBudget,
  settleBudget,
  type CreatorBudgetLedger,
  type CreatorBudgetState,
} from '../src/creator-budget.js';
import {
  createCreatorPaidRequests,
  type ApprovedImageQuote,
} from '../src/creator-paid-requests.js';

const endpoint = 'https://api.openai.com/v1/images/generations';
const prompt = 'A simple cinematic product storyboard frame.';
const quote: ApprovedImageQuote = {
  model: 'gpt-image-2-2026-04-21',
  size: '1024x1536',
  quality: 'medium',
  promptHash: createHash('sha256').update(prompt).digest('hex'),
  maxCostCents: 10,
};
const body = {
  model: quote.model,
  size: quote.size,
  quality: quote.quality,
  prompt,
  n: 1,
  output_format: 'png',
};
const request = (extra: Record<string, unknown> = {}, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer fixture-only' },
  body: JSON.stringify({ ...body, ...extra }),
  signal,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  delegate: typeof fetch,
  beforeSettle?: (cents: number) => Promise<void>,
  beforeReserve?: () => Promise<void>,
) {
  const state: CreatorBudgetState = { limitCents: 100, reservations: [] };
  const ledger: CreatorBudgetLedger = {
    budget: async () => budgetSnapshot(state),
    reserve: async (input, options) => {
      await beforeReserve?.();
      return reserveBudget(state, input, options);
    },
    settle: async (id, cents) => {
      await beforeSettle?.(cents);
      return settleBudget(state, id, cents);
    },
  };
  const gate = createCreatorPaidRequests(delegate);
  gate.attach(ledger);
  return { gate, state, ledger };
}

test('one approved image reserves exactly 10 cents before transport and settles the same ceiling', async () => {
  let calls = 0;
  const f = fixture(async (_input, init) => {
    calls++;
    assert.deepEqual(
      [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
      [10, 0],
    );
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    assert.equal(init?.redirect, 'error');
    return Response.json({ data: [] });
  });
  const response = await f.gate.approvedImage(quote, randomUUID(), () =>
    f.gate.fetch(endpoint, request()),
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(
    [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
    [0, 10],
  );
});

test('unapproved requests and unsupported price ceilings cannot reach image transport', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw new Error('Unexpected paid request');
  });
  await assert.rejects(f.gate.fetch(endpoint, request()), {
    code: 'CREATOR_IMAGE_APPROVAL_REQUIRED',
  });
  await assert.rejects(
    f.gate.approvedImage({ ...quote, maxCostCents: 11 }, randomUUID(), () =>
      f.gate.fetch(endpoint, request()),
    ),
    { code: 'CREATOR_IMAGE_PRICE' },
  );
  assert.equal(calls, 0);
  assert.equal(f.state.reservations.length, 0);
});

test('approved image parameters are exact and mismatch refunds known-unused holds', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw new Error('Unexpected paid request');
  });
  for (const change of [
    { prompt: 'A different prompt' },
    { model: 'unpriced-model' },
    { size: '1536x1024' },
    { quality: 'high' },
    { n: 2 },
    { output_format: 'jpeg' },
    { background: 'transparent' },
  ])
    await assert.rejects(
      f.gate.approvedImage(quote, randomUUID(), () => f.gate.fetch(endpoint, request(change))),
      { code: 'CREATOR_IMAGE_QUOTE_MISMATCH' },
    );
  assert.equal(calls, 0);
  assert.deepEqual(
    [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
    [0, 0],
  );
});

test('image approval cannot cover another OpenAI operation or another provider', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return Response.json({});
  });
  for (const url of [
    'https://api.openai.com/v1/responses',
    'https://queue.fal.run/unapproved-model',
  ])
    await assert.rejects(
      f.gate.approvedImage(quote, randomUUID(), () => f.gate.fetch(url, request())),
      { code: 'CREATOR_IMAGE_QUOTE_MISMATCH' },
    );
  assert.equal(calls, 0);
  assert.equal(budgetSnapshot(f.state).reservedCents, 0);
});

for (const throwOnRejection of [true, false])
  test(`known rejected image request refunds its hold (${throwOnRejection ? 'adapter throws' : 'response returned'})`, async () => {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return Response.json({ error: 'No access' }, { status: 401 });
    });
    const operation = () =>
      f.gate.approvedImage(quote, randomUUID(), async () => {
        const response = await f.gate.fetch(endpoint, request());
        if (throwOnRejection && !response.ok) throw new Error('Provider rejected image');
        return response;
      });
    if (throwOnRejection) await assert.rejects(operation(), /Provider rejected image/);
    else assert.equal((await operation()).status, 401);
    assert.equal(calls, 1);
    assert.deepEqual(
      [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
      [0, 0],
    );
  });

test('unknown image submission outcomes retain the 10 cent hold and are never retried automatically', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw new Error('Response connection ended');
  });
  const id = randomUUID();
  await assert.rejects(
    f.gate.approvedImage(quote, id, () => f.gate.fetch(endpoint, request())),
    /Response connection ended/,
  );
  await assert.rejects(
    f.gate.approvedImage(quote, id, () => f.gate.fetch(endpoint, request())),
    { code: 'CREATOR_IMAGE_REQUEST_CONFLICT' },
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
    [10, 0],
  );
});

for (const outcome of ['succeeded', 'unknown'])
  test(`a fresh gate rejects a reused image request ID from another session after ${outcome}`, async () => {
    const id = randomUUID();
    const originalQuote = { ...quote, sessionId: randomUUID() };
    const f = fixture(async () => {
      if (outcome === 'unknown') throw new Error('Unknown provider outcome');
      return Response.json({ data: [] });
    });
    const first = () =>
      f.gate.approvedImage(originalQuote, id, () => f.gate.fetch(endpoint, request()));
    if (outcome === 'unknown') await assert.rejects(first(), /Unknown provider outcome/);
    else await first();
    let replayCalls = 0;
    const reopened = createCreatorPaidRequests(async () => {
      replayCalls++;
      return Response.json({ data: [] });
    });
    reopened.attach(f.ledger);
    const otherSessionQuote = { ...originalQuote, sessionId: randomUUID() };
    await assert.rejects(
      reopened.approvedImage(otherSessionQuote, id, () => reopened.fetch(endpoint, request())),
    );
    assert.equal(
      replayCalls,
      0,
      'a durable ledger key cannot fund a second dispatch after restart',
    );
    assert.equal(f.state.reservations.length, 1);
    const budget = budgetSnapshot(f.state);
    assert.deepEqual(
      [budget.reservedCents, budget.chargedCents],
      outcome === 'unknown' ? [10, 0] : [0, 10],
    );
  });

test('a failed final source check sends no image request and releases its hold', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw new Error('Unexpected paid request');
  });
  await assert.rejects(
    f.gate.approvedImage(
      quote,
      randomUUID(),
      () => f.gate.fetch(endpoint, request()),
      async () => {
        throw new Error('Source changed');
      },
    ),
    /Source changed/,
  );
  assert.equal(calls, 0);
  assert.equal(budgetSnapshot(f.state).reservedCents, 0);
});

test('two concurrent fetches in one approval admit only one paid image transport', async () => {
  const both = deferred();
  let arrivals = 0,
    calls = 0;
  const f = fixture(async () => {
    calls++;
    return Response.json({ data: [] });
  });
  await f.gate.approvedImage(
    quote,
    randomUUID(),
    async () => {
      const attempts = await Promise.allSettled([
        f.gate.fetch(endpoint, request()),
        f.gate.fetch(endpoint, request()),
      ]);
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    },
    async () => {
      arrivals++;
      if (arrivals === 2) both.resolve();
      await both.promise;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
    [0, 10],
  );
});

test('a detached image request cannot dispatch while its unused hold is being refunded', async () => {
  const checkEntered = deferred(),
    releaseCheck = deferred(),
    refundEntered = deferred(),
    releaseRefund = deferred();
  let calls = 0;
  const f = fixture(
    async () => {
      calls++;
      return Response.json({ data: [] });
    },
    async (cents) => {
      if (cents === 0) {
        refundEntered.resolve();
        await releaseRefund.promise;
      }
    },
  );
  let late: Promise<Response | Error> | undefined;
  const operation = f.gate
    .approvedImage(
      quote,
      randomUUID(),
      async () => {
        late = f.gate.fetch(endpoint, request()).then(
          (response) => response,
          (error: Error) => error,
        );
        await checkEntered.promise;
        throw new Error('Image operation ended before dispatch');
      },
      async () => {
        checkEntered.resolve();
        await releaseCheck.promise;
      },
    )
    .then(
      () => undefined,
      (error: Error) => error,
    );
  await refundEntered.promise;
  releaseCheck.resolve();
  const lateResult = await late;
  releaseRefund.resolve();
  const operationResult = await operation;
  assert.ok(operationResult instanceof Error);
  assert.ok(
    lateResult instanceof Error,
    'closed scopes reject even while refund persistence is pending',
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
    [0, 0],
  );
});

const referenceApproval: {
  reviewed: true;
  costReviewed: true;
  maxCostCents: 50;
  sourceHash: string;
} = {
  reviewed: true,
  costReviewed: true,
  maxCostCents: 50,
  sourceHash: 'a'.repeat(64),
};
const referenceRequest = (): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-6-luna',
    input: 'Describe only the supplied reference frames.',
    max_output_tokens: 2048,
  }),
});
const referenceEndpoint = 'https://api.openai.com/v1/responses';

test('reference approval retains the normal 50 cent reservation and actual usage accounting', async () => {
  let calls = 0,
    sourceChecks = 0;
  const f = fixture(async () => {
    calls++;
    assert.deepEqual(
      [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
      [50, 0],
    );
    return Response.json({ usage: { input_tokens: 1000, output_tokens: 1000 } });
  });
  await f.gate.approvedReference(
    referenceApproval,
    () => f.gate.fetch(referenceEndpoint, referenceRequest()),
    async () => {
      sourceChecks++;
    },
  );
  assert.deepEqual([calls, sourceChecks], [1, 1]);
  assert.deepEqual(
    [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
    [0, 1],
  );
});

test('reference edits during reservation are checked again before paid transport and refund the unused hold', async () => {
  let sourceVersion = 1,
    calls = 0;
  const f = fixture(
    async () => {
      calls++;
      return Response.json({});
    },
    undefined,
    async () => {
      sourceVersion = 2;
    },
  );
  await assert.rejects(
    f.gate.approvedReference(
      referenceApproval,
      () => f.gate.fetch(referenceEndpoint, referenceRequest()),
      async () => {
        if (sourceVersion !== 1) throw new Error('Reference source changed');
      },
    ),
    /Reference source changed/,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    [budgetSnapshot(f.state).reservedCents, budgetSnapshot(f.state).chargedCents],
    [0, 0],
  );
});

test('finished reference approvals reject detached calls before transport', async () => {
  const checking = deferred(),
    release = deferred();
  let calls = 0,
    late: Promise<Response | Error> | undefined;
  const f = fixture(async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    f.gate.approvedReference(
      referenceApproval,
      async () => {
        late = f.gate.fetch(referenceEndpoint, referenceRequest()).then(
          (response) => response,
          (error: Error) => error,
        );
        await checking.promise;
        throw new Error('Reference operation ended');
      },
      async () => {
        checking.resolve();
        await release.promise;
      },
    ),
    /Reference operation ended/,
  );
  release.resolve();
  assert.ok((await late) instanceof Error);
  assert.equal(calls, 0);
  assert.equal(budgetSnapshot(f.state).reservedCents, 0);
});
