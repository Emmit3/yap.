import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { ApiError } from '../src/errors.js';
import {
  buildCreatorQuote,
  productionProfile,
  type CreatorBudgetLedger,
} from '../src/creator-budget.js';
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
async function fixture(t: TestContext, creatorOptions: AppOptions['creatorOptions']) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-creator-production-')),
    app = await createApp({
      dataFile: join(directory, 'projects.json'),
      workflowProviderConfig: { provider: 'guided' },
      creatorOptions,
    });
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
async function narrationFixture(t: TestContext, options: AppOptions['creatorOptions']) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'narration-fixture-no-external-requests';
  try {
    return await fixture(t, options);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
}
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

test('production audits actual decoded clips, requires a new quote for retries and serves a real assembled MP4 with music', async (t) => {
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
  // No narration key is configured here, so the default soundtrack is the bundled music bed.
  assert.equal(next.session.plan?.audio?.voice, null);
  assert.ok(next.session.plan?.audio?.musicTrackId);
  assert.equal(result.job.output?.hasAudio, true);
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

async function makeSpeech(directory: string, seconds: number): Promise<Buffer> {
  const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
  const path = join(directory, `speech-${seconds}.wav`);
  const process = spawn(
    binary as string,
    [
      '-hide_banner',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=220:sample_rate=24000:duration=${seconds}`,
      '-ac',
      '1',
      '-y',
      path,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  assert.equal((await once(process, 'close'))[0], 0);
  return readFile(path);
}
async function streams(directory: string, bytes: Buffer): Promise<string> {
  const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
  const path = join(directory, `probe-${randomUUID()}.mp4`);
  await writeFile(path, bytes);
  const process = spawn(binary as string, ['-hide_banner', '-i', path, '-f', 'null', '-'], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  process.stderr.on('data', (value: Buffer) => (log += value.toString('utf8')));
  assert.equal((await once(process, 'close'))[0], 0);
  return log;
}
const passingProduction = (clip: () => Buffer) => ({
  video: {
    configured: true,
    cancel: async () => {},
    generate: async ({ onSubmitted }: { onSubmitted: (id: string) => Promise<void> }) => {
      await onSubmitted(randomUUID());
      return clip();
    },
  },
  auditor: {
    configured: true,
    audit: async () => ({
      technicalPassed: true,
      visionPassed: true,
      summary: 'Sampled frames match the approved shot.',
      issues: [],
    }),
  },
});
async function produce(f: Fixture, value: CreatorSessionResponse) {
  const response = await f.request(
    `/sessions/${value.session.id}/produce`,
    json('POST', {
      expectedVersion: value.session.version,
      approvalId: value.session.approval!.id,
      quoteId: value.session.approval!.quoteId!,
      requestId: randomUUID(),
    }),
  );
  assert.equal(response.status, 202, await response.clone().text());
  const started = creatorJobResponseSchema.parse(await response.json());
  return done(f, value.session.id, started.job.id);
}

test('narration is quoted, held, recorded before any clip and mixed with music into the final MP4', async (t) => {
  let clip: Buffer | undefined, speech: Buffer | undefined;
  const order: string[] = [],
    spoken: string[][] = [];
  const base = passingProduction(() => clip!);
  const f = await fixture(t, {
    ...base,
    video: {
      ...base.video,
      generate: async (input) => {
        order.push('clip');
        return base.video.generate(input);
      },
    },
    voiceover: {
      configured: true,
      narrate: async (lines, voice) => {
        order.push('narration');
        spoken.push(lines);
        assert.equal(voice, 'marin');
        return lines.map(() => speech!);
      },
    },
  });
  clip = await makeVideo(f.directory);
  speech = await makeSpeech(f.directory, 2);
  const capabilities = (await (await f.request('/capabilities')).json()) as {
    voices: string[];
    musicTracks: Array<{ id: string }>;
  };
  assert.ok(capabilities.voices.includes('marin'));
  assert.ok(capabilities.musicTracks.length >= 1);
  const preview = await f.request(`/music/${capabilities.musicTracks[0]!.id}`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type') ?? '', /audio\/mp4/);
  await preview.arrayBuffer();
  assert.equal((await f.request('/music/not-a-track')).status, 400);

  const draft = await prepared(f);
  assert.equal(draft.session.plan?.audio?.voice, 'marin');
  assert.equal(draft.session.plan?.hasAudio, true);
  const quoted = await f.request(
    `/sessions/${draft.session.id}/quote`,
    json('POST', {
      expectedVersion: draft.session.version,
      expectedWorkflowVersion: draft.workflow.version,
    }),
  );
  const { quote } = creatorQuoteResponseSchema.parse(await quoted.json());
  assert.ok(quote.narratedSegments >= 1);
  assert.equal(quote.audioCents, quote.narratedSegments * 10);
  assert.equal(
    quote.maxCostCents,
    quote.clips.reduce((sum, item) => sum + item.costCents, 0) + quote.audioCents,
  );
  const result = await produce(f, await reviewQuote(f, draft));
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job.error));
  assert.equal(order[0], 'narration', 'the cheapest paid step runs before any clip is generated');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0]!.length, quote.narratedSegments);
  assert.equal(result.job.output?.hasAudio, true);
  assert.equal(result.job.output?.duration, 15);
  const final = await f.request(`/sessions/${draft.session.id}/jobs/${result.job.id}/video`);
  const log = await streams(f.directory, Buffer.from(await final.arrayBuffer()));
  assert.match(log, /Video: h264[^\n]* 1080x1920/);
  assert.match(log, /Audio: aac[^\n]*48000 Hz, stereo/);
  const ledger = await CreatorRepository.open(join(f.directory, 'creator-sessions.json'));
  const budget = await ledger.budget();
  assert.equal(
    budget.reservedCents + budget.chargedCents,
    quote.maxCostCents,
    'the narration hold stays in full because the provider reports no usage',
  );
});

test('a creator can turn sound off, and a rejected narration key stops production before clips are bought', async (t) => {
  let clip: Buffer | undefined,
    generated = 0;
  const base = passingProduction(() => clip!);
  const f = await fixture(t, {
    ...base,
    video: {
      ...base.video,
      generate: async (input) => {
        generated++;
        return base.video.generate(input);
      },
    },
    voiceover: {
      configured: true,
      narrate: async () => {
        throw new ApiError(502, 'CREATOR_VOICEOVER_REJECTED', 'OpenAI rejected the API key.');
      },
    },
  });
  clip = await makeVideo(f.directory);
  const draft = await prepared(f);
  const rejected = await produce(f, await reviewQuote(f, draft));
  assert.equal(rejected.job.status, 'failed');
  assert.equal(rejected.job.error?.code, 'CREATOR_VOICEOVER_REJECTED');
  assert.equal(generated, 0);
  const ledger = await CreatorRepository.open(join(f.directory, 'creator-sessions.json'));
  assert.deepEqual(
    [(await ledger.budget()).reservedCents, (await ledger.budget()).chargedCents],
    [0, 0],
    'a definite rejection and untouched clip holds are all released',
  );

  const current = creatorSessionResponseSchema.parse(
    await (await f.request(`/sessions/${draft.session.id}`)).json(),
  );
  const unknown = await f.request(
    `/sessions/${draft.session.id}/plan`,
    json('PATCH', {
      expectedVersion: current.session.version,
      expectedWorkflowVersion: current.workflow.version,
      clips: current.session.plan!.clips,
      caption: current.session.plan!.caption,
      audio: { voice: null, musicTrackId: 'not-a-track' },
    }),
  );
  assert.equal(unknown.status, 400);
  const muted = await f.request(
    `/sessions/${draft.session.id}/plan`,
    json('PATCH', {
      expectedVersion: current.session.version,
      expectedWorkflowVersion: current.workflow.version,
      clips: current.session.plan!.clips,
      caption: current.session.plan!.caption,
      audio: { voice: null, musicTrackId: null },
    }),
  );
  assert.equal(muted.status, 200, await muted.clone().text());
  const silent = creatorSessionResponseSchema.parse(await muted.json());
  assert.equal(silent.session.plan?.hasAudio, false);
  const result = await produce(f, await reviewQuote(f, silent));
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job.error));
  assert.equal(result.job.output?.hasAudio, false);
  const final = await f.request(`/sessions/${draft.session.id}/jobs/${result.job.id}/video`);
  assert.doesNotMatch(await streams(f.directory, Buffer.from(await final.arrayBuffer())), /Audio:/);
});

test('a stale plan before the first narration submission releases every unused hold', async (t) => {
  let request: Fixture['request'] | undefined;
  let sessionId = '',
    narrated = 0,
    submitted = 0,
    generated = 0;
  const f = await fixture(t, {
    video: {
      configured: true,
      cancel: async () => {},
      generate: async () => {
        generated++;
        throw new Error('No clip request should be submitted.');
      },
    },
    auditor: {
      configured: true,
      audit: async () => {
        throw new Error('No visual audit should be submitted.');
      },
    },
    voiceover: {
      configured: true,
      narrate: async (_lines, _voice, _tone, _signal, beforeSubmit) => {
        narrated++;
        assert.ok(request);
        const current = creatorSessionResponseSchema.parse(
          await (await request(`/sessions/${sessionId}`)).json(),
        );
        const edited = await request(
          `/sessions/${sessionId}/plan`,
          json('PATCH', {
            expectedVersion: current.session.version,
            expectedWorkflowVersion: current.workflow.version,
            clips: current.session.plan!.clips,
            caption: current.session.plan!.caption,
            audio: { voice: 'cedar', musicTrackId: null },
          }),
        );
        assert.equal(edited.status, 200, await edited.clone().text());
        assert.ok(beforeSubmit);
        await beforeSubmit();
        submitted++;
        throw new Error('The stale source must stop narration before submission.');
      },
    },
  });
  request = f.request;
  const draft = await prepared(f);
  sessionId = draft.session.id;
  const result = await produce(f, await reviewQuote(f, draft));
  assert.equal(result.job.status, 'failed');
  assert.equal(result.job.error?.code, 'CREATOR_SOURCE_CHANGED');
  assert.deepEqual([narrated, submitted, generated], [1, 0, 0]);
  await f.shutdown();
  const { budget } = await (await f.request('/budget')).json();
  assert.deepEqual([budget.reservedCents, budget.chargedCents], [0, 0]);
});

test('partial and unknown narration submissions retain the approved audio ceiling', async (t) => {
  for (const outcome of ['partial', 'unknown'] as const)
    await t.test(outcome, async (t) => {
      let request: Fixture['request'] | undefined;
      let sessionId = '',
        submitted = 0,
        generated = 0;
      const f = await narrationFixture(t, {
        video: {
          configured: true,
          cancel: async () => {},
          generate: async () => {
            generated++;
            throw new Error('No clip should be purchased after narration fails.');
          },
        },
        auditor: {
          configured: true,
          audit: async () => {
            throw new Error('No visual audit should be submitted.');
          },
        },
        fetch: async (input) => {
          assert.equal(String(input), 'https://api.openai.com/v1/audio/speech');
          submitted++;
          if (outcome === 'unknown') throw new Error('The connection lost its response.');
          assert.ok(request);
          const current = creatorSessionResponseSchema.parse(
            await (await request(`/sessions/${sessionId}`)).json(),
          );
          const edited = await request(
            `/sessions/${sessionId}/plan`,
            json('PATCH', {
              expectedVersion: current.session.version,
              expectedWorkflowVersion: current.workflow.version,
              clips: current.session.plan!.clips,
              caption: current.session.plan!.caption,
              audio: { voice: 'cedar', musicTrackId: null },
            }),
          );
          assert.equal(edited.status, 200, await edited.clone().text());
          return new Response(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000)]));
        },
      });
      request = f.request;
      const draft = await prepared(f);
      sessionId = draft.session.id;
      const result = await produce(f, await reviewQuote(f, draft));
      assert.equal(result.job.status, 'failed');
      assert.equal(
        result.job.error?.code,
        outcome === 'partial' ? 'CREATOR_SOURCE_CHANGED' : 'CREATOR_VOICEOVER_FAILED',
      );
      assert.deepEqual([submitted, generated], [1, 0]);
      await f.shutdown();
      const { budget } = await (await f.request('/budget')).json();
      assert.deepEqual([budget.reservedCents, budget.chargedCents], [30, 0]);
    });
});

test('live cancellation before narration refunds its hold while a crash snapshot stays conservative', async (t) => {
  let announce = () => {};
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const f = await fixture(t, {
    video: {
      configured: true,
      cancel: async () => {},
      generate: async () => {
        throw new Error('No clip should be submitted.');
      },
    },
    auditor: {
      configured: true,
      audit: async () => {
        throw new Error('No visual audit should be submitted.');
      },
    },
    voiceover: {
      configured: true,
      narrate: async (_lines, _voice, _tone, signal) =>
        new Promise<Buffer[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          announce();
        }),
    },
  });
  const reviewed = await reviewQuote(f, await prepared(f));
  const response = await f.request(
    `/sessions/${reviewed.session.id}/produce`,
    json('POST', {
      expectedVersion: reviewed.session.version,
      approvalId: reviewed.session.approval!.id,
      quoteId: reviewed.session.approval!.quoteId!,
      requestId: randomUUID(),
    }),
  );
  assert.equal(response.status, 202, await response.clone().text());
  const { job } = creatorJobResponseSchema.parse(await response.json());
  await entered;
  const snapshot = join(f.directory, 'interrupted-audio.json');
  await writeFile(snapshot, await readFile(join(f.directory, 'creator-sessions.json')));
  const restarted = await CreatorRepository.open(snapshot);
  assert.equal(
    (await restarted.job(reviewed.session.id, job.id)).error?.code,
    'CREATOR_INTERRUPTED',
  );
  await restarted.releaseUnusedReservations(reviewed.session.id, job.id);
  assert.equal((await restarted.budget()).reservedCents, 30);
  const canceled = await f.request(`/sessions/${reviewed.session.id}/jobs/${job.id}`, {
    method: 'DELETE',
  });
  assert.equal(canceled.status, 200);
  await f.shutdown();
  const { budget } = await (await f.request('/budget')).json();
  assert.deepEqual([budget.reservedCents, budget.chargedCents], [0, 0]);
});

test('narrated plans reject interleaved spoken groups while silent and contiguous clip orders remain valid', async (t) => {
  let narrated = 0;
  const video = {
    configured: true,
    cancel: async () => {},
    generate: async () => {
      throw new Error('Plan validation must not generate a clip.');
    },
  };
  const f = await fixture(t, {
    video,
    voiceover: {
      configured: true,
      narrate: async () => {
        narrated++;
        throw new Error('Plan validation must not record narration.');
      },
    },
  });
  const draft = await prepared(f);
  const plan = draft.session.plan!;
  const [a, b, c] = plan.clips;
  assert.ok(a && b && c);
  const splitA = { ...a, id: randomUUID(), seconds: 3 };
  const interleaved = [{ ...a, seconds: 2 }, b, splitA, c];
  assert.throws(
    () =>
      buildCreatorQuote(
        { ...draft.session, plan: { ...plan, clips: interleaved } },
        draft.workflow,
        productionProfile(video),
        [],
      ),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_VOICEOVER_SCENE_ORDER',
    'a previously saved interleaved plan must fail quote preflight',
  );
  const rejected = await f.request(
    `/sessions/${draft.session.id}/plan`,
    json('PATCH', {
      expectedVersion: draft.session.version,
      expectedWorkflowVersion: draft.workflow.version,
      caption: plan.caption,
      clips: interleaved,
      audio: plan.audio,
    }),
  );
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'CREATOR_VOICEOVER_SCENE_ORDER');
  const silentResponse = await f.request(
    `/sessions/${draft.session.id}/plan`,
    json('PATCH', {
      expectedVersion: draft.session.version,
      expectedWorkflowVersion: draft.workflow.version,
      caption: plan.caption,
      clips: interleaved,
      audio: { voice: null, musicTrackId: null },
    }),
  );
  assert.equal(silentResponse.status, 200, await silentResponse.clone().text());
  const silent = creatorSessionResponseSchema.parse(await silentResponse.json());
  assert.doesNotThrow(() =>
    buildCreatorQuote(silent.session, silent.workflow, productionProfile(video), []),
  );
  assert.ok(plan.audio?.musicTrackId);
  const musicResponse = await f.request(
    `/sessions/${draft.session.id}/plan`,
    json('PATCH', {
      expectedVersion: silent.session.version,
      expectedWorkflowVersion: silent.workflow.version,
      caption: plan.caption,
      clips: interleaved,
      audio: { voice: null, musicTrackId: plan.audio.musicTrackId },
    }),
  );
  assert.equal(musicResponse.status, 200, await musicResponse.clone().text());
  const music = creatorSessionResponseSchema.parse(await musicResponse.json());
  assert.equal(music.session.plan?.hasAudio, true);
  assert.doesNotThrow(() =>
    buildCreatorQuote(music.session, music.workflow, productionProfile(video), []),
  );
  const contiguousResponse = await f.request(
    `/sessions/${draft.session.id}/plan`,
    json('PATCH', {
      expectedVersion: music.session.version,
      expectedWorkflowVersion: music.workflow.version,
      caption: plan.caption,
      clips: [{ ...a, seconds: 2 }, splitA, b, c],
      audio: { voice: 'marin', musicTrackId: null },
    }),
  );
  assert.equal(contiguousResponse.status, 200, await contiguousResponse.clone().text());
  const contiguous = creatorSessionResponseSchema.parse(await contiguousResponse.json());
  assert.doesNotThrow(() =>
    buildCreatorQuote(contiguous.session, contiguous.workflow, productionProfile(video), []),
  );
  assert.equal(narrated, 0);
});
