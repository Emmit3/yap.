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
import { creatorSessionResponseSchema, creatorJobResponseSchema } from '@yap/contracts/creator';
import { createApp, type AppOptions } from '../src/app.js';
import { CreatorRepository } from '../src/creator-repository.js';
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
  return { directory, request: (path: string, init?: RequestInit) => fetch(base + path, init) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function approved(f: Fixture) {
  let response = await f.request(
    '/sessions',
    json('POST', {
      input: { mode: 'text', prompt: 'Ceramic cups in soft studio light', urls: [] },
    }),
  );
  let value = creatorSessionResponseSchema.parse(await response.json());
  for (const route of ['prepare', 'approve']) {
    response = await f.request(
      `/sessions/${value.session.id}/${route}`,
      json('POST', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        ...(route === 'approve' ? { planId: value.session.plan!.id, reviewed: true } : {}),
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    value = creatorSessionResponseSchema.parse(await response.json());
  }
  return value;
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

test('production audits actual decoded clips, retries within approved budget and serves a real silent assembled MP4', async (t) => {
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
          visionPassed: reviews !== 1,
          summary:
            reviews === 1 ? 'One composition issue.' : 'Sampled frames match the approved shot.',
          issues: reviews === 1 ? ['Keep the subject centered.'] : [],
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
  const result = await done(f, id, started.job.id);
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result.job.error));
  assert.equal(paid, 4);
  assert.equal(reviews, 4);
  assert.equal(result.job.clips.filter((clip) => clip.status === 'passed').length, 3);
  assert.equal(result.job.output?.duration, 15);
  assert.equal(result.job.output?.hasAudio, false);
  assert.ok(result.job.clips[0]?.audit?.issues.includes('Keep the subject centered.'));
  assert.match(result.job.clips[1]!.prompt!, /Correct these visible issues/);
  const response = await f.request(`/sessions/${id}/jobs/${started.job.id}/video`, {
    headers: { Range: 'bytes=0-31' },
  });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 32);
  const passed = result.job.clips.find((clip) => clip.status === 'passed')!;
  const preview = await f.request(
    `/sessions/${id}/jobs/${started.job.id}/clips/${passed.clipId}/video?attempt=${passed.attempt}`,
  );
  assert.equal(preview.status, 200);
  await preview.arrayBuffer();
  const persisted = await CreatorRepository.open(join(f.directory, 'creator-sessions.json'));
  assert.equal((await persisted.job(id, started.job.id)).clips.length, 4);
  await f.request(
    `/sessions/${id}`,
    json('PATCH', {
      expectedVersion: result.session.version,
      answers: [{ questionId: 'audience', answer: 'A changed audience' }],
    }),
  );
  assert.equal((await f.request(`/sessions/${id}/jobs/${started.job.id}/video`)).status, 409);
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
        requestId: randomUUID(),
      }),
    ),
    f.request(
      `/sessions/${b.session.id}/produce`,
      json('POST', {
        expectedVersion: b.session.version,
        approvalId: b.session.approval!.id,
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
  const value = await approved(f),
    id = value.session.id;
  for (let index = 0; index < 2; index++) {
    const reviewedAgain = await f.request(
      `/sessions/${id}/approve`,
      json('POST', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        planId: value.session.plan!.id,
        reviewed: true,
      }),
    );
    assert.equal(reviewedAgain.status, 200);
    const unchanged = creatorSessionResponseSchema.parse(await reviewedAgain.json());
    assert.deepEqual(unchanged, value);
    const response = await f.request(
      `/sessions/${id}/produce`,
      json('POST', {
        expectedVersion: value.session.version,
        approvalId: value.session.approval!.id,
        requestId: randomUUID(),
      }),
    );
    assert.equal(response.status, 202);
    const job = creatorJobResponseSchema.parse(await response.json()).job,
      result = await done(f, id, job.id);
    assert.equal(result.job.status, 'failed');
    assert.equal(result.job.error?.code, 'CREATOR_CLIP_AUDIT_FAILED');
  }
  assert.equal(paid, 2);
});
