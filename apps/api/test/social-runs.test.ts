import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { socialResearchRunInputSchema, socialResearchRunSchema } from '@yap/contracts/social';
import { ApiError } from '../src/errors.js';
import { SocialResearchRuns } from '../src/social-runs.js';

const input = socialResearchRunInputSchema.parse({ topic: 'Coffee experiments', mode: 'demo' });
test('runs expose bounded real lifecycle events, immutable snapshots, and only created allowlisted artifacts', async () => {
  const runs = new SocialResearchRuns();
  const investigationId = randomUUID();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const initial = runs.start(input, 'demo_replay', async ({ emit, writeArtifact }) => {
    writeArtifact('/research/scope.json', JSON.stringify({ topic: input.topic }));
    for (let i = 0; i < 230; i++)
      emit({
        agent: 'source_researcher',
        task: 'collect',
        phase: 'progress',
        message: `Validated illustrative source batch ${i}.`,
        resultCount: 1,
      });
    await gate;
    return investigationId;
  });
  assert.equal(initial.status, 'queued');
  assert.equal(initial.execution, 'demo_replay');
  await setImmediate();
  const progress = socialResearchRunSchema.parse(runs.get(initial.id));
  assert.equal(progress.status, 'running');
  assert.equal(progress.events.length, 200);
  assert.equal(progress.eventsTruncated, true);
  assert.ok(
    progress.events.every(
      (event, index) => index === 0 || event.sequence > progress.events[index - 1]!.sequence,
    ),
  );
  assert.ok(progress.artifacts.some((artifact) => artifact.path === '/research/scope.json'));
  assert.equal(
    runs.artifact(initial.id, '/research/scope.json').content,
    JSON.stringify({ topic: input.topic }),
  );
  for (const path of [
    '../../.env',
    'C:\\secret.env',
    '/research/private-reasoning.md',
    '/research/brief.md',
  ])
    assert.throws(
      () => runs.artifact(initial.id, path),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
  progress.events[0]!.message = 'Changed only in caller copy';
  assert.notEqual(runs.get(initial.id).events[0]?.message, 'Changed only in caller copy');
  release();
  const complete = await runs.wait(initial.id);
  assert.equal(complete.status, 'completed');
  assert.equal(complete.investigationId, investigationId);
  assert.equal(complete.events.at(-1)?.phase, 'completed');
  assert.equal(runs.activeCount, 0);
  await runs.close();
});

test('two active runs are allowed, cancellation rejects late work, and shutdown releases pending executions', async () => {
  const runs = new SocialResearchRuns();
  let lateEmit: (() => void) | undefined;
  const first = runs.start(input, 'pipeline', async (context) => {
    lateEmit = () =>
      context.emit({
        agent: 'coordinator',
        task: 'persist',
        phase: 'completed',
        message: 'Late result',
      });
    return new Promise<string>(() => undefined);
  });
  const second = runs.start(input, 'pipeline', async () => new Promise<string>(() => undefined));
  assert.throws(
    () => runs.start(input, 'pipeline', async () => randomUUID()),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
  await setImmediate();
  const canceled = runs.cancel(first.id);
  const sequence = canceled.lastSequence;
  assert.equal(canceled.status, 'canceled');
  lateEmit?.();
  assert.equal(runs.get(first.id).lastSequence, sequence);
  assert.equal(runs.get(first.id).investigationId, null);
  await runs.close();
  assert.equal(runs.get(second.id).status, 'canceled');
  assert.throws(() => runs.start(input, 'pipeline', async () => randomUUID()), /shutting down/);
});

test('deadlines terminate an unresponsive executor and unexpected SDK errors never become public messages', async () => {
  const runs = new SocialResearchRuns({ timeoutMs: 10 });
  const stuck = runs.start(input, 'deepagents', async () => new Promise<string>(() => undefined));
  const timedOut = await runs.wait(stuck.id);
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.error?.code, 'SOCIAL_RUN_TIMEOUT');
  const broken = runs.start(input, 'deepagents', async () => {
    throw new Error('Authorization Bearer secret-value; model private trace');
  });
  const failed = await runs.wait(broken.id);
  assert.equal(failed.error?.code, 'SOCIAL_RUN_FAILED');
  assert.doesNotMatch(JSON.stringify(failed), /secret-value|private trace/);
  await runs.close();
});

test('atomic save is a visible commit boundary and cancellation never falsely hides a persisted result', async () => {
  const runs = new SocialResearchRuns({ timeoutMs: 10 });
  let announce = () => {};
  let release = () => {};
  const began = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const investigationId = randomUUID();
  const run = runs.start(input, 'pipeline', async (context) =>
    context.commit(async () => {
      announce();
      await gate;
      return investigationId;
    }),
  );
  await began;
  assert.equal(runs.get(run.id).canCancel, false);
  const cancelResponse = runs.cancel(run.id);
  assert.equal(cancelResponse.status, 'running');
  assert.match(cancelResponse.events.at(-1)?.message ?? '', /final save has already started/);
  await delay(20);
  assert.equal(runs.get(run.id).status, 'running');
  release();
  const result = await runs.wait(run.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.investigationId, investigationId);
  assert.equal(result.canCancel, false);
  await runs.close();
});

test('artifacts cannot exceed byte budgets or announce nonexistent scratch files', async () => {
  const runs = new SocialResearchRuns();
  const oversized = runs.start(input, 'pipeline', async ({ writeArtifact }) => {
    writeArtifact('/research/brief.md', '咖'.repeat(30000));
    return randomUUID();
  });
  const first = await runs.wait(oversized.id);
  assert.equal(first.error?.code, 'SOCIAL_ARTIFACT_BUDGET');
  assert.deepEqual(first.artifacts, []);
  const premature = runs.start(input, 'pipeline', async ({ emit }) => {
    emit({
      agent: 'coordinator',
      task: 'scope',
      phase: 'completed',
      message: 'File ready',
      artifactPath: '/research/scope.json',
    });
    return randomUUID();
  });
  assert.equal((await runs.wait(premature.id)).error?.code, 'SOCIAL_ARTIFACT_MISSING');
  const invalid = runs.start(input, 'pipeline', async ({ writeArtifact }) => {
    writeArtifact('/research/scope.json', 'not JSON');
    return randomUUID();
  });
  assert.equal((await runs.wait(invalid.id)).error?.code, 'SOCIAL_ARTIFACT_INVALID');
  await runs.close();
});

test('completed telemetry is limited to fifty runs and expires without affecting persistent investigations', async () => {
  let now = new Date('2026-11-13T12:00:00.000Z');
  const runs = new SocialResearchRuns({ now: () => now });
  let first = '';
  let last = '';
  for (let index = 0; index < 51; index++) {
    const run = runs.start(input, 'pipeline', async () => randomUUID());
    if (!first) first = run.id;
    last = run.id;
    await runs.wait(run.id);
    now = new Date(now.valueOf() + 1);
  }
  assert.throws(() => runs.get(first), /expired/);
  assert.equal(runs.get(last).status, 'completed');
  now = new Date(now.valueOf() + 30 * 60 * 1000 + 1);
  assert.throws(() => runs.get(last), /expired/);
  await runs.close();
});
