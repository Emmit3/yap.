import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import {
  creatorSessionResponseSchema,
  creatorJobResponseSchema,
  creatorQuoteResponseSchema,
  type CreatorSessionResponse,
} from '@yap/contracts/creator';
import { createApp, type AppOptions } from '../src/app.js';
import { CreatorRepository } from '../src/creator-repository.js';
import type { CreatorBudgetLedger } from '../src/creator-budget.js';
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
async function fixture(t: TestContext, creatorOptions: AppOptions['creatorOptions']) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-creator-production-')),
    app = await createApp({ dataFile: join(directory, 'projects.json'), creatorOptions });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/creator`;
  t.after(async () => {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    shutdown: () => app.locals.shutdown(),
    request: (path: string, init?: RequestInit) => fetch(base + path, init),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function reviewQuote(f: Fixture, value: CreatorSessionResponse) {
  const response = await f.request(
    '/sessions/' + value.session.id + '/quote',
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const { quote } = creatorQuoteResponseSchema.parse(await response.json());
  const approved = await f.request(
    '/sessions/' + value.session.id + '/approve',
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
      planId: value.session.plan!.id,
      reviewed: true,
      costReviewed: true,
      quoteId: quote.id,
    }),
  );
  assert.equal(approved.status, 200, await approved.clone().text());
  return creatorSessionResponseSchema.parse(await approved.json());
}
async function prepared(f: Fixture) {
  const response = await f.request(
    '/sessions',
    json('POST', {
      input: { mode: 'text', prompt: 'Ceramic cups in soft studio light', urls: [] },
    }),
  );
  let value = creatorSessionResponseSchema.parse(await response.json());
  const prepared = await f.request(
    '/sessions/' + value.session.id + '/prepare',
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
    }),
  );
  assert.equal(prepared.status, 200, await prepared.clone().text());
  value = creatorSessionResponseSchema.parse(await prepared.json());
  return value;
}
async function approved(f: Fixture) {
  return reviewQuote(f, await prepared(f));
}
async function done(f: Fixture, sessionId: string, jobId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const response = await f.request(`/sessions/${sessionId}/jobs/${jobId}`),
      value = creatorJobResponseSchema.parse(await response.json());
    if (['succeeded', 'failed', 'canceled'].includes(value.job.status)) return value;
    await delay(30);
  }
  throw new Error('Production did not finish.');
}
async function makeVideo(directory: string): Promise<Buffer> {
  const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
  assert.equal(typeof binary, 'string');
  const path = join(directory, 'fixture.mp4');
  const process = spawn(
    binary as string,
    [
      '-hide_banner',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=360x640:rate=24',
      '-t',
      '4.8',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-y',
      path,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  assert.equal((await once(process, 'close'))[0], 0);
  return readFile(path);
}

test('production audits actual decoded clips, requires a new quote for retries and serves a real silent assembled MP4', async (t) => {
  let bytes: Buffer | undefined,
    paid = 0,
    reviews = 0;
  const f = await fixture(t, {
    video: {
      configured: true,
      cancel: async () => {},
      generate: async ({ onSubmitted }) => {
        paid++;
        await onSubmitted(randomUUID());
        assert.ok(bytes);
        return bytes;
      },
    },
    auditor: {
      configured: true,
      audit: async (_clip, frames) => {
        reviews++;
        assert.equal(frames.length, 3);
        assert.ok(frames.every((frame) => frame.length > 100));
        return {
          technicalPassed: true,
          visionPassed: reviews !== 2,
          summary:
            reviews === 2 ? 'One composition issue.' : 'Sampled frames match the approved shot.',
          issues: reviews === 2 ? ['Keep the subject centered.'] : [],
        };
      },
    },
  });
  bytes = await makeVideo(f.directory);
  const value = await approved(f),
    id = value.session.id,
    requestId = randomUUID(),
    body = {
      expectedVersion: value.session.version,
      approvalId: value.session.approval!.id,
      quoteId: value.session.approval!.quoteId!,
      requestId,
    };
  const [first, duplicate] = await Promise.all([
    f.request(`/sessions/${id}/produce`, json('POST', body)),
    f.request(`/sessions/${id}/produce`, json('POST', body)),
  ]);
  assert.equal(first.status, 202, await first.clone().text());
  assert.equal(duplicate.status, 202, await duplicate.clone().text());
  const started = creatorJobResponseSchema.parse(await first.json());
  assert.equal(creatorJobResponseSchema.parse(await duplicate.json()).job.id, started.job.id);
  const failed = await done(f, id, started.job.id);
  assert.equal(failed.job.status, 'failed');
  assert.equal(paid, 2, 'a failed audit never automatically starts attempt two');
  const consumed = await f.request(
    '/sessions/' + id + '/produce',
    json('POST', { ...body, requestId: randomUUID() }),
  );
  assert.equal(consumed.status, 409);
  const next = await reviewQuote(f, value);
  const retried = await f.request(
    '/sessions/' + id + '/produce',
    json('POST', {
      expectedVersion: next.session.version,
      approvalId: next.session.approval!.id,
      quoteId: next.session.approval!.quoteId!,
      requestId: randomUUID(),
    }),
  );
  assert.equal(retried.status, 202, await retried.clone().text());
  const retry = creatorJobResponseSchema.parse(await retried.json());
  const result = await done(f, id, retry.job.id);
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job.error));
  assert.equal(paid, 4);
  assert.equal(reviews, 4);
  assert.equal(result.job.clips.filter((clip) => clip.status === 'passed').length, 3);
  assert.equal(result.job.output?.duration, 15);
  assert.equal(result.job.output?.hasAudio, false);
  assert.ok(failed.job.clips[1]?.audit?.issues.includes('Keep the subject centered.'));
  assert.equal(
    result.job.clips[1]!.prompt,
    next.session.plan!.clips[1]!.prompt,
    'retry uses the reviewed prompt without hidden corrections',
  );
  const response = await f.request(`/sessions/${id}/jobs/${retry.job.id}/video`, {
    headers: { Range: 'bytes=0-31' },
  });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 32);
  const passed = result.job.clips.find((clip) => clip.status === 'passed')!;
  const preview = await f.request(
    `/sessions/${id}/jobs/${retry.job.id}/clips/${passed.clipId}/video?attempt=${passed.attempt}`,
  );
  assert.equal(preview.status, 200);
  await preview.arrayBuffer();
  const persisted = await CreatorRepository.open(join(f.directory, 'creator-sessions.json'));
  assert.equal((await persisted.job(id, retry.job.id)).clips.length, 3);
  await f.request(
    `/sessions/${id}`,
    json('PATCH', {
      expectedVersion: result.session.version,
      answers: [{ questionId: 'audience', answer: 'A changed audience' }],
    }),
  );
  assert.equal((await f.request(`/sessions/${id}/jobs/${retry.job.id}/video`)).status, 409);
});

test('one global paid worker spans sessions and cancellation preserves submitted attempt receipts', async (t) => {
  let submits = 0;
  const f = await fixture(t, {
    video: {
      configured: true,
      cancel: async () => {},
      generate: async ({ onSubmitted, signal }) => {
        submits++;
        await onSubmitted(randomUUID());
        await delay(60000, undefined, { signal });
        throw new Error('unexpected completion');
      },
    },
    auditor: {
      configured: true,
      audit: async () => {
        throw new Error('No frame audit should run.');
      },
    },
  });
  const a = await approved(f),
    b = await approved(f);
  const [first, second] = await Promise.all([
    f.request(
      `/sessions/${a.session.id}/produce`,
      json('POST', {
        expectedVersion: a.session.version,
        approvalId: a.session.approval!.id,
        quoteId: a.session.approval!.quoteId!,
        requestId: randomUUID(),
      }),
    ),
    f.request(
      `/sessions/${b.session.id}/produce`,
      json('POST', {
        expectedVersion: b.session.version,
        approvalId: b.session.approval!.id,
        quoteId: b.session.approval!.quoteId!,
        requestId: randomUUID(),
      }),
    ),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [202, 429]);
  const accepted = first.status === 202 ? first : second,
    id = first.status === 202 ? a.session.id : b.session.id,
    job = creatorJobResponseSchema.parse(await accepted.json()).job;
  for (let index = 0; index < 100 && submits === 0; index++) await delay(5);
  assert.equal(submits, 1);
  const canceled = await f.request(`/sessions/${id}/jobs/${job.id}`, { method: 'DELETE' });
  assert.equal(canceled.status, 200);
  const result = await done(f, id, job.id);
  assert.equal(result.job.status, 'canceled');
  assert.equal(result.job.clips.length, 1);
  assert.ok(result.job.clips[0]?.providerTaskId);
  assert.match(result.job.error!.message, /bill/);
});

test('manual retries cannot reset the durable two-attempt budget for the same approved clip', async (t) => {
  let bytes: Buffer | undefined,
    paid = 0;
  const f = await fixture(t, {
    video: {
      configured: true,
      cancel: async () => {},
      generate: async ({ onSubmitted }) => {
        paid++;
        await onSubmitted(randomUUID());
        assert.ok(bytes);
        return bytes;
      },
    },
    auditor: {
      configured: true,
      audit: async () => ({
        technicalPassed: true,
        visionPassed: false,
        summary: 'The subject was visibly deformed.',
        issues: ['Preserve the subject shape.'],
      }),
    },
  });
  bytes = await makeVideo(f.directory);
  let value = await approved(f);
  const id = value.session.id;
  const planId = value.session.plan!.id;
  for (let index = 0; index < 2; index++) {
    if (index) value = await reviewQuote(f, value);
    assert.equal(value.session.plan!.id, planId);
    const response = await f.request(
      '/sessions/' + id + '/produce',
      json('POST', {
        expectedVersion: value.session.version,
        approvalId: value.session.approval!.id,
        quoteId: value.session.approval!.quoteId!,
        requestId: randomUUID(),
      }),
    );
    assert.equal(response.status, 202, await response.clone().text());
    const job = creatorJobResponseSchema.parse(await response.json()).job;
    const result = await done(f, id, job.id);
    assert.equal(result.job.error?.code, 'CREATOR_CLIP_AUDIT_FAILED');
    assert.equal(paid, index + 1);
    value = creatorSessionResponseSchema.parse(await (await f.request('/sessions/' + id)).json());
  }
  const exhausted = await f.request(
    '/sessions/' + id + '/quote',
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
    }),
  );
  assert.equal(exhausted.status, 409);
  assert.equal((await exhausted.json()).error.code, 'CREATOR_ATTEMPTS_EXHAUSTED');
  assert.equal(paid, 2);
});

test('HTTP cost review rejects edited plans and insufficient shared budget before any paid submission', async (t) => {
  let ledger: CreatorBudgetLedger | undefined;
  let paid = 0;
  const f = await fixture(t, {
    withBudget: (budget) => {
      ledger = budget;
      return {};
    },
    video: {
      configured: true,
      cancel: async () => {},
      generate: async () => {
        paid++;
        throw new Error('No paid submission is expected.');
      },
    },
    auditor: {
      configured: true,
      audit: async () => {
        throw new Error('No audit is expected.');
      },
    },
  });
  const value = await prepared(f);
  const quoted = await f.request(
    '/sessions/' + value.session.id + '/quote',
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
    }),
  );
  assert.equal(quoted.status, 200);
  const { quote, budget } = creatorQuoteResponseSchema.parse(await quoted.json());
  assert.equal(budget.limitCents, 3000);
  assert.equal(quote.maxCostCents, 270);
  const noCostReview = await f.request(
    '/sessions/' + value.session.id + '/approve',
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
      planId: value.session.plan!.id,
      reviewed: true,
      quoteId: quote.id,
    }),
  );
  assert.equal(noCostReview.status, 400);
  const editedResponse = await f.request(
    '/sessions/' + value.session.id + '/plan',
    json('PATCH', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
      caption: value.session.plan!.caption,
      clips: value.session.plan!.clips.map((clip, index) =>
        index ? clip : { ...clip, prompt: 'A newly reviewed composition.' },
      ),
    }),
  );
  assert.equal(editedResponse.status, 200, await editedResponse.clone().text());
  const edited = creatorSessionResponseSchema.parse(await editedResponse.json());
  const stale = await f.request(
    '/sessions/' + value.session.id + '/approve',
    json('POST', {
      expectedVersion: edited.session.version,
      expectedWorkflowVersion: edited.workflow.version,
      planId: edited.session.plan!.id,
      reviewed: true,
      costReviewed: true,
      quoteId: quote.id,
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'CREATOR_QUOTE_STALE');
  const current = await reviewQuote(f, edited);
  assert.ok(ledger);
  await ledger.reserve({
    idempotencyKey: 'concurrent-research',
    category: 'research',
    sourceId: 'other-analysis',
    amountCents: 2800,
  });
  const blocked = await f.request(
    '/sessions/' + current.session.id + '/produce',
    json('POST', {
      expectedVersion: current.session.version,
      approvalId: current.session.approval!.id,
      quoteId: current.session.approval!.quoteId!,
      requestId: randomUUID(),
    }),
  );
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, 'CREATOR_BUDGET_EXCEEDED');
  assert.equal(paid, 0);
  assert.equal((await ledger.budget()).reservedCents, 2800);
  const snapshot = await f.request('/budget');
  assert.equal((await snapshot.json()).budget.availableCents, 200);
});

test('shutdown waits for submitted provider cleanup and retains only started clip holds', async (t) => {
  let submitted!: () => void;
  const started = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    video: {
      configured: true,
      cancel: async () => {},
      generate: async ({ onSubmitted, signal, beforeSubmit }) => {
        await beforeSubmit?.();
        await onSubmitted('submitted-task');
        submitted();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await cleanup;
        signal.throwIfAborted();
        throw new Error('No completion is expected.');
      },
    },
    auditor: {
      configured: true,
      audit: async () => {
        throw new Error('No audit is expected.');
      },
    },
  });
  const value = await approved(f);
  const response = await f.request(
    '/sessions/' + value.session.id + '/produce',
    json('POST', {
      expectedVersion: value.session.version,
      approvalId: value.session.approval!.id,
      quoteId: value.session.approval!.quoteId!,
      requestId: randomUUID(),
    }),
  );
  assert.equal(response.status, 202);
  await started;
  let closed = false;
  const closing = f.shutdown().then(() => {
    closed = true;
  });
  await delay(25);
  assert.equal(closed, false, 'shutdown must await cancellation and receipt cleanup');
  release();
  await closing;
  const repository = await CreatorRepository.open(join(f.directory, 'creator-sessions.json'));
  assert.equal((await repository.budget()).reservedCents, 90);
  const job = (await repository.jobs(value.session.id))[0]!;
  assert.equal(job.status, 'canceled');
  assert.equal(job.clips[0]?.providerTaskId, 'submitted-task');
  const late = await f.request(
    '/sessions/' + value.session.id + '/produce',
    json('POST', {
      expectedVersion: value.session.version,
      approvalId: value.session.approval!.id,
      quoteId: value.session.approval!.quoteId!,
      requestId: randomUUID(),
    }),
  );
  assert.equal(late.status, 503);
});
