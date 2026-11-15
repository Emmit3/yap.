import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SnapshotError, inspect, list, restore, save } from '../scripts/demo-snapshot.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-demo-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = join(directory, 'data'),
    snapshots = join(directory, 'snapshots');
  async function write(spentCents, finished) {
    await mkdir(join(data, 'creator-videos'), { recursive: true });
    await writeFile(
      join(data, 'creator-sessions.json'),
      JSON.stringify({
        jobs: [
          {
            id: 'job-1',
            sessionId: 'session-1',
            kind: 'production',
            status: finished ? 'succeeded' : 'failed',
            output: finished ? { duration: 15, hasAudio: true } : null,
          },
          { id: 'job-2', sessionId: 'session-2', kind: 'analysis', status: 'succeeded' },
        ],
        budget: {
          reservations: [
            { amountCents: spentCents, chargedCents: null },
            { amountCents: 50, chargedCents: 0 },
          ],
        },
      }),
    );
    if (finished) await writeFile(join(data, 'creator-videos', 'job-1.mp4'), 'film');
  }
  return { data, snapshots, write };
}

test('a snapshot needs a finished film whose file exists, and never overwrites another', async (t) => {
  const f = await fixture(t);
  await f.write(100, false);
  await assert.rejects(save({ ...f, name: 'demo' }), SnapshotError);
  await f.write(100, true);
  assert.deepEqual(await inspect(f.data), {
    films: [{ sessionId: 'session-1', jobId: 'job-1', seconds: 15, hasAudio: true }],
    spentCents: 100,
  });
  assert.equal((await save({ ...f, name: 'demo' })).films.length, 1);
  await assert.rejects(save({ ...f, name: 'demo' }), SnapshotError);
  await assert.rejects(save({ ...f, name: '../escape' }), SnapshotError);
  assert.deepEqual(
    (await list(f.snapshots)).map((item) => [item.name, item.films.length]),
    [['demo', 1]],
  );
});

test('restore keeps the replaced data and refuses to forget newer spending', async (t) => {
  const f = await fixture(t);
  await f.write(100, true);
  await save({ ...f, name: 'demo' });
  await f.write(250, false);
  await assert.rejects(restore({ ...f, name: 'demo' }), /more spending/);
  await assert.rejects(restore({ ...f, name: 'missing' }), SnapshotError);
  const result = await restore({ ...f, name: 'demo', allowBudgetRewind: true });
  assert.equal((await inspect(f.data)).spentCents, 100);
  assert.equal(await readFile(join(f.data, 'creator-videos', 'job-1.mp4'), 'utf8'), 'film');
  assert.equal((await inspect(result.replaced)).spentCents, 250, 'the newer data is kept aside');
});
