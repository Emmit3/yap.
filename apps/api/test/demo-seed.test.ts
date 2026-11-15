import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { creatorSessionResponseSchema } from '@yap/contracts/creator';
import { createApp } from '../src/app.js';
import { createWorkflowProvider } from '../src/workflow-provider.js';
import { CreatorRepository } from '../src/creator-repository.js';
import { demoInput, demoLabel, localOrigin, seedDemo } from '../../../scripts/demo-seed.mjs';

const mediaDirectory = resolve(import.meta.dirname, '../../../public/media');
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-demo-seed-'));
  const ledger = await CreatorRepository.open(join(directory, 'creator-sessions.json'));
  const charged = await ledger.reserve({
    idempotencyKey: 'prior-paid-film',
    category: 'video',
    sourceId: 'existing-film',
    amountCents: 120,
  });
  await ledger.settle(charged.id, 95);
  await ledger.reserve({
    idempotencyKey: 'prior-uncertain-request',
    category: 'video',
    sourceId: 'existing-film',
    amountCents: 60,
  });
  const forbidden = async () => {
    throw new Error('External provider calls are forbidden in seed tests.');
  };
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    workflowProvider: createWorkflowProvider({ provider: 'guided' }),
    workflowFetch: forbidden,
    socialFetch: forbidden,
    creatorOptions: { analyze: forbidden, fetch: forbidden },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const apiOrigin = `http://127.0.0.1:${address.port}`;
  const calls: Array<{ method: string; path: string }> = [];
  const transport: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const path = parsed.pathname;
    assert.ok(
      (method === 'POST' && path === '/api/creator/sessions') ||
        (method === 'GET' && /^\/api\/creator\/sessions\/[a-f0-9-]+$/.test(path)) ||
        (method === 'POST' && /^\/api\/workflows\/[a-f0-9-]+\/assets$/.test(path)) ||
        (method === 'PATCH' && /^\/api\/workflows\/[a-f0-9-]+\/assets\/[a-f0-9-]+$/.test(path)),
      `Unexpected seed request: ${method} ${path}`,
    );
    calls.push({ method, path });
    return fetch(url, init);
  };
  const options = {
    apiOrigin,
    webOrigin: 'http://127.0.0.1:5173',
    manifestFile: join(directory, 'manifests/mori.json'),
    mediaDirectory,
    transport,
  };
  const request = (path: string, init?: RequestInit) => fetch(apiOrigin + path, init);
  t.after(async () => {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, options, request, calls };
}

test('real API seed/rerun/new preserves creator edits, unrelated records and spending', async (t) => {
  const f = await fixture(t);
  const user = creatorSessionResponseSchema.parse(
    await (
      await f.request(
        '/api/creator/sessions',
        json('POST', {
          input: { mode: 'text', prompt: 'My unrelated pottery project.', urls: [] },
        }),
      )
    ).json(),
  );
  const budgetBefore = await (await f.request('/api/creator/budget')).json();
  assert.equal(budgetBefore.budget.chargedCents, 95);
  assert.equal(budgetBefore.budget.reservedCents, 60);
  const first = await seedDemo(f.options);
  assert.equal(first.reused, false);
  assert.equal(first.ready, true);
  assert.match(first.url, new RegExp(first.sessionId));
  let saved = creatorSessionResponseSchema.parse(
    await (await f.request(`/api/creator/sessions/${first.sessionId}`)).json(),
  );
  assert.equal(saved.session.input.tone, 'conversational');
  assert.equal(saved.session.input.duration, 15);
  assert.ok(saved.session.input.prompt.startsWith(demoLabel));
  assert.equal(saved.workflow.assets.length, 2);
  assert.equal(saved.workflow.script, null);
  assert.equal(saved.session.plan, null);
  assert.equal(saved.session.approval, null);
  for (const asset of saved.workflow.assets) {
    assert.match(asset.description, /Illustrative licensed stock.*fictional Mori Drinks/);
    assert.match(asset.description, /Not a real Mori Drinks location or Yap-generated image/);
  }
  const changed = await f.request(
    `/api/creator/sessions/${first.sessionId}`,
    json('PATCH', {
      expectedVersion: saved.session.version,
      answers: [{ questionId: 'productName', answer: 'Mori presenter edit' }],
    }),
  );
  assert.equal(changed.status, 200);
  saved = creatorSessionResponseSchema.parse(await changed.json());
  const asset = saved.workflow.assets[0]!;
  const assetResponse = await f.request(
    `/api/workflows/${saved.workflow.id}/assets/${asset.id}`,
    json('PATCH', {
      expectedVersion: saved.workflow.version,
      description: 'Presenter-authored photo description; preserve this edit.',
    }),
  );
  assert.equal(assetResponse.status, 200);
  const beforeReuse = await (await f.request(`/api/creator/sessions/${first.sessionId}`)).json();
  f.calls.length = 0;
  const second = await seedDemo(f.options);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.reused, true);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['GET'],
  );
  assert.deepEqual(
    await (await f.request(`/api/creator/sessions/${first.sessionId}`)).json(),
    beforeReuse,
  );
  const fresh = await seedDemo({ ...f.options, fresh: true });
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.ok(
    (await readdir(join(f.directory, 'manifests'))).some((file) => file.endsWith('.previous.json')),
  );
  assert.deepEqual(
    await (await f.request(`/api/creator/sessions/${user.session.id}`)).json(),
    user,
  );
  assert.deepEqual(
    await (await f.request(`/api/creator/sessions/${first.sessionId}`)).json(),
    beforeReuse,
  );
  assert.deepEqual(await (await f.request('/api/creator/budget')).json(), budgetBefore);
});

test('lost upload response resumes existing hash and missing description without duplicate photos', async (t) => {
  const f = await fixture(t);
  let interrupted = false;
  await assert.rejects(
    seedDemo({
      ...f.options,
      transport: async (url: string, init: RequestInit) => {
        const response = await f.options.transport(url, init);
        if (!interrupted && init?.method === 'POST' && new URL(url).pathname.endsWith('/assets')) {
          interrupted = true;
          await response.arrayBuffer();
          throw new Error('Simulated lost successful upload response.');
        }
        return response;
      },
    }),
    /lost successful upload response/,
  );
  const pointer = JSON.parse(await readFile(f.options.manifestFile, 'utf8'));
  assert.equal(pointer.ready, false);
  const partial = creatorSessionResponseSchema.parse(
    await (await f.request(`/api/creator/sessions/${pointer.sessionId}`)).json(),
  );
  assert.equal(partial.workflow.assets.length, 1);
  assert.equal(partial.workflow.assets[0]!.description, '');
  f.calls.length = 0;
  const resumed = await seedDemo(f.options);
  assert.equal(resumed.sessionId, pointer.sessionId);
  assert.equal(resumed.ready, true);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  const current = creatorSessionResponseSchema.parse(
    await (await f.request(`/api/creator/sessions/${pointer.sessionId}`)).json(),
  );
  assert.equal(current.workflow.assets.length, 2);
  assert.equal(new Set(current.workflow.assets.map((photo) => photo.sha256)).size, 2);
  assert.ok(current.workflow.assets.every((photo) => photo.description.includes('Photo by')));
});

test('changed photo hashes are rejected before touching API or seed pointer', async (t) => {
  const f = await fixture(t);
  const media = join(f.directory, 'changed-media');
  await mkdir(media);
  for (const file of ['credits.json', 'product-matcha.jpg', 'product-espresso.jpg'])
    await copyFile(join(mediaDirectory, file), join(media, file));
  await writeFile(join(media, 'product-matcha.jpg'), 'changed bytes');
  await assert.rejects(seedDemo({ ...f.options, mediaDirectory: media }), /missing or has changed/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(f.options.manifestFile), { code: 'ENOENT' });
});

test('a mismatched saved pointer refuses mutations and preserves the referenced user record', async (t) => {
  const f = await fixture(t);
  const seeded = await seedDemo(f.options);
  const pointer = JSON.parse(await readFile(f.options.manifestFile, 'utf8'));
  pointer.workflowId = '00000000-0000-4000-8000-000000000000';
  await writeFile(f.options.manifestFile, JSON.stringify(pointer));
  const before = await (await f.request(`/api/creator/sessions/${seeded.sessionId}`)).json();
  f.calls.length = 0;
  await assert.rejects(seedDemo(f.options), /no longer identifies the demo fixture/);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['GET'],
  );
  assert.deepEqual(
    await (await f.request(`/api/creator/sessions/${seeded.sessionId}`)).json(),
    before,
  );
});

test('only loopback origins without paths, credentials or redirects are accepted', () => {
  for (const origin of [
    'https://example.com',
    'http://localhost:3001/path',
    'http://user@localhost',
    'http://localhost/?key=x',
  ]) {
    assert.throws(() => localOrigin(origin), /loopback origin/);
  }
  assert.equal(localOrigin('http://[::1]:3001'), 'http://[::1]:3001');
  assert.equal(demoInput.input.tone, 'conversational');
});

test('concurrent seeds share one manifest lock and cannot create competing fixtures', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = seedDemo({
    ...f.options,
    transport: async (url: string, init: RequestInit) => {
      if (init?.method === 'POST' && new URL(url).pathname === '/api/creator/sessions') {
        entered();
        await hold;
      }
      return f.options.transport(url, init);
    },
  });
  await ready;
  try {
    await assert.rejects(seedDemo(f.options), /Another seed may be running/);
    assert.equal(f.calls.length, 0);
  } finally {
    release();
  }
  assert.equal((await first).ready, true);
  assert.equal(f.calls.filter((call) => call.path === '/api/creator/sessions').length, 1);
});
