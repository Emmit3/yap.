import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
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
// Failed status is saved before the worker's finally block releases unused clip holds.
async function settledBudget(f: Fixture, expected: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { budget } = await (await f.request('/budget')).json();
    if (budget.reservedCents + budget.chargedCents === expected) return budget;
    await delay(20);
  }
  throw new Error(`The production budget did not settle to ${expected} cents.`);
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
  assert.equal(result.job.output?.subtitles?.timingSource, 'scene');
  assert.ok(
    result.job.events.some(({ message }) => message.startsWith('Saved the final MP4 with music.')),
  );
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
  assert.equal((await f.request(`/sessions/${id}/jobs/${retry.job.id}/subtitles.srt`)).status, 409);
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
      narrate: async (lines, voice, _tone, _signal, beforeSubmit) => {
        order.push('narration');
        spoken.push(lines);
        assert.equal(voice, 'marin');
        for (const _line of lines) await beforeSubmit?.();
        return lines.map(() => speech!);
      },
    },
  });
  clip = await makeVideo(f.directory);
  speech = await makeSpeech(f.directory, 4);
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
  assert.equal(result.job.output?.subtitles?.timingSource, 'narration');
  assert.ok(
    result.job.events.some(({ message }) =>
      message.startsWith('Saved the final MP4 with narration and music.'),
    ),
  );
  const subtitlePath = `/sessions/${draft.session.id}/jobs/${result.job.id}/subtitles.srt`;
  const subtitleResponse = await f.request(subtitlePath);
  assert.equal(subtitleResponse.status, 200);
  assert.match(subtitleResponse.headers.get('content-type') ?? '', /application\/x-subrip/);
  assert.match(subtitleResponse.headers.get('content-type') ?? '', /charset=utf-8/);
  assert.equal(subtitleResponse.headers.get('cache-control'), 'private, no-store');
  assert.equal(subtitleResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(subtitleResponse.headers.get('content-disposition') ?? '', /yap-creation.srt/);
  const subtitleBytes = Buffer.from(await subtitleResponse.arrayBuffer());
  assert.equal(
    createHash('sha256').update(subtitleBytes).digest('hex'),
    result.job.output!.subtitles!.sha256,
  );
  const subtitleFile = join(f.directory, 'creator-videos', result.job.id, 'subtitles.srt');
  await writeFile(subtitleFile, 'tampered');
  assert.equal((await f.request(subtitlePath)).status, 500);
  await writeFile(subtitleFile, subtitleBytes);
  const other = await prepared(f);
  assert.equal(
    (await f.request(`/sessions/${other.session.id}/jobs/${result.job.id}/subtitles.srt`)).status,
    404,
  );
  assert.equal(result.job.output?.duration, 15);
  const final = await f.request(`/sessions/${draft.session.id}/jobs/${result.job.id}/video`);
  const log = await streams(f.directory, Buffer.from(await final.arrayBuffer()));
  assert.match(log, /Video: h264[^\n]* 1080x1920/);
  assert.match(log, /Audio: aac[^\n]*48000 Hz, stereo/);
  const ledger = await CreatorRepository.open(join(f.directory, 'creator-sessions.json'));
  assert.deepEqual(
    (await ledger.job(draft.session.id, result.job.id)).output?.subtitles,
    result.job.output?.subtitles,
  );
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
      narrate: async (_lines, _voice, _tone, _signal, beforeSubmit) => {
        await beforeSubmit?.();
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
  const budget = await settledBudget(f, 0);
  assert.deepEqual(
    [budget.reservedCents, budget.chargedCents],
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
      subtitlesEnabled: false,
    }),
  );
  assert.equal(muted.status, 200, await muted.clone().text());
  const silent = creatorSessionResponseSchema.parse(await muted.json());
  assert.equal(silent.session.plan?.hasAudio, false);
  const result = await produce(f, await reviewQuote(f, silent));
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job.error));
  assert.equal(result.job.output?.hasAudio, false);
  assert.equal(result.job.output?.subtitles, undefined);
  assert.ok(
    result.job.events.some(({ message }) =>
      message.startsWith('Saved the final MP4 without sound.'),
    ),
  );
  assert.equal(
    (await f.request(`/sessions/${draft.session.id}/jobs/${result.job.id}/subtitles.srt`)).status,
    409,
  );
  const final = await f.request(`/sessions/${draft.session.id}/jobs/${result.job.id}/video`);
  assert.doesNotMatch(await streams(f.directory, Buffer.from(await final.arrayBuffer())), /Audio:/);
});

test('the narration hold is released when nothing was submitted and kept once a line was', async (t) => {
  let clip: Buffer | undefined,
    generated = 0,
    submitted = 0,
    lineCount = 0,
    mode: 'changed' | 'failed' = 'changed';
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
      narrate: async (lines, _voice, _tone, _signal, beforeSubmit) => {
        lineCount = lines.length;
        if (mode === 'changed') {
          // The creator edits the plan after production starts but before the first line leaves.
          const now = creatorSessionResponseSchema.parse(
            await (await f.request(`/sessions/${sessionId}`)).json(),
          );
          const edited = await f.request(
            `/sessions/${sessionId}/plan`,
            json('PATCH', {
              expectedVersion: now.session.version,
              expectedWorkflowVersion: now.workflow.version,
              clips: now.session.plan!.clips,
              caption: now.session.plan!.caption,
              audio: { voice: 'cedar', musicTrackId: null },
            }),
          );
          assert.equal(edited.status, 200, await edited.clone().text());
        }
        await beforeSubmit?.();
        submitted++;
        throw new ApiError(502, 'CREATOR_VOICEOVER_FAILED', 'The narration provider failed.');
      },
    },
  });
  clip = await makeVideo(f.directory);
  const draft = await prepared(f);
  const sessionId = draft.session.id;
  const changed = await produce(f, await reviewQuote(f, draft));
  assert.equal(changed.job.status, 'failed');
  assert.equal(changed.job.error?.code, 'CREATOR_SOURCE_CHANGED');
  assert.deepEqual([submitted, generated], [0, 0]);
  let budget = await settledBudget(f, 0);
  assert.deepEqual(
    [budget.reservedCents, budget.chargedCents],
    [0, 0],
    'a plan change before the first line leaves releases the whole narration hold',
  );

  mode = 'failed';
  const current = creatorSessionResponseSchema.parse(
    await (await f.request(`/sessions/${sessionId}`)).json(),
  );
  const failed = await produce(f, await reviewQuote(f, current));
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.error?.code, 'CREATOR_VOICEOVER_FAILED');
  assert.deepEqual([submitted, generated], [1, 0]);
  budget = await settledBudget(f, lineCount * 10);
  assert.ok(lineCount > 0);
  assert.equal(
    budget.reservedCents + budget.chargedCents,
    lineCount * 10,
    'an uncertain outcome after a line left keeps the conservative narration hold',
  );
});

test('subtitle preference is free, defaults on for new plans, survives sparse saves and invalidates approval', async (t) => {
  const f = await fixture(
    t,
    passingProduction(() => {
      throw new Error('No paid calls');
    }),
  );
  const draft = await prepared(f);
  assert.equal(draft.session.plan?.subtitlesEnabled, true);
  const quote = async (value: CreatorSessionResponse) => {
    const response = await f.request(
      `/sessions/${value.session.id}/quote`,
      json('POST', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return creatorQuoteResponseSchema.parse(await response.json()).quote;
  };
  const original = await quote(draft),
    approved = await reviewQuote(f, draft);
  assert.equal(original.subtitlesEnabled, true);
  const patch = async (value: CreatorSessionResponse, option?: boolean) => {
    const response = await f.request(
      `/sessions/${value.session.id}/plan`,
      json('PATCH', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        caption: value.session.plan!.caption,
        clips: value.session.plan!.clips,
        ...(option === undefined ? {} : { subtitlesEnabled: option }),
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return creatorSessionResponseSchema.parse(await response.json());
  };
  const off = await patch(approved, false);
  assert.equal(off.session.approval, null);
  assert.equal(off.session.plan!.subtitlesEnabled, false);
  const offQuote = await quote(off);
  assert.equal(offQuote.subtitlesEnabled, false);
  assert.equal(offQuote.maxCostCents, original.maxCostCents);
  assert.notEqual(offQuote.fingerprint, original.fingerprint);
  const sparse = await patch(off);
  assert.equal(sparse.session.plan!.subtitlesEnabled, false);
  const stale = await f.request(
    `/sessions/${sparse.session.id}/approve`,
    json('POST', {
      expectedVersion: sparse.session.version,
      expectedWorkflowVersion: sparse.workflow.version,
      planId: sparse.session.plan!.id,
      quoteId: original.id,
      reviewed: true,
      costReviewed: true,
    }),
  );
  assert.equal(stale.status, 409);
});

test('a restored historical plan stays subtitle-free on an unrelated plan save and quote', async (t) => {
  const options = passingProduction(() => {
    throw new Error('No paid calls');
  });
  const f = await fixture(t, options),
    draft = await prepared(f);
  await f.shutdown();
  const path = join(f.directory, 'creator-sessions.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  delete state.sessions.find((item: { id: string }) => item.id === draft.session.id).plan
    .subtitlesEnabled;
  await writeFile(path, JSON.stringify(state));
  const app = await createApp({
    dataFile: join(f.directory, 'projects.json'),
    workflowProviderConfig: { provider: 'guided' },
    creatorOptions: options,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/creator`;
  t.after(async () => {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const saved = await fetch(
    `${base}/sessions/${draft.session.id}/plan`,
    json('PATCH', {
      expectedVersion: draft.session.version,
      expectedWorkflowVersion: draft.workflow.version,
      caption: draft.session.plan!.caption,
      clips: draft.session.plan!.clips,
    }),
  );
  assert.equal(saved.status, 200, await saved.clone().text());
  const value = creatorSessionResponseSchema.parse(await saved.json());
  assert.equal(Object.hasOwn(value.session.plan!, 'subtitlesEnabled'), false);
  const quoted = await fetch(
    `${base}/sessions/${value.session.id}/quote`,
    json('POST', {
      expectedVersion: value.session.version,
      expectedWorkflowVersion: value.workflow.version,
    }),
  );
  assert.equal(quoted.status, 200, await quoted.clone().text());
  assert.equal(
    Object.hasOwn(creatorQuoteResponseSchema.parse(await quoted.json()).quote, 'subtitlesEnabled'),
    false,
  );
});
