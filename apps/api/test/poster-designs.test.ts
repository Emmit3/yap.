import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import express, { type ErrorRequestHandler, type Express } from 'express';
import sharp from 'sharp';
import {
  posterStylesResponseSchema,
  posterDesignResponseSchema,
  type PosterStyle,
} from '@yap/contracts/posters';
import { ApiError, StorageError } from '../src/errors.js';
import { createPosterRouter } from '../src/poster-router.js';
import { createApp } from '../src/app.js';

const recipeMarker =
  'Private recipe: reserve a wide upper margin and use one red geometric figure.';
const observedMarker = 'Private observation: an asymmetric headline and a low visual anchor.';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-poster-designs-'));
  const root = join(directory, 'references');
  const file = join(directory, 'private', 'poster-designs.json');
  await mkdir(join(root, 'crops'), { recursive: true });
  const image = await sharp({
    create: { width: 12, height: 18, channels: 3, background: '#c42323' },
  })
    .png()
    .toBuffer();
  await writeFile(join(root, 'crops', 'style-one.png'), image);
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      references: [
        {
          id: 'style-one',
          title: 'Red geometric study',
          category: 'music',
          source: { url: 'https://www.instagram.com/reel/DfVgIHsB1sk/', timestampSeconds: 8 },
          crop: {
            file: 'crops/style-one.png',
            reviewedPosterOnly: true,
            reviewedAt: '2026-11-14T12:00:00.000Z',
          },
          observed: {
            provenance: 'visual_inspection',
            layout: observedMarker,
            typography: 'One large sans-serif headline.',
            palette: ['red', 'cream'],
            imagery: 'One geometric figure.',
            texture: 'Fine grain.',
          },
          reconstruction: {
            provenance: 'authored_from_visual_reference',
            instructions: [recipeMarker],
          },
        },
      ],
    }),
  );
  const servers: ReturnType<Express['listen']>[] = [];
  async function serve(app?: Express) {
    if (!app) {
      app = express();
      app.use(express.json());
      app.use('/api/posters', createPosterRouter({ rootDirectory: root, dataFile: file }));
      const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
        if (error instanceof ApiError)
          response
            .status(error.status)
            .json({ error: { code: error.code, message: error.message } });
        else
          response.status(500).json({
            error: { code: error instanceof StorageError ? 'STORAGE_ERROR' : 'INTERNAL_ERROR' },
          });
      };
      app.use(errors);
    }
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    return (path: string, init?: RequestInit) => fetch(`${base}/api/posters${path}`, init);
  }
  t.after(async () => {
    for (const server of servers)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('yap-poster-designs-'));
    await rm(directory, { recursive: true, force: true });
  });
  const request = await serve();
  const style = posterStylesResponseSchema.parse(await (await request('/styles')).json())
    .styles[0]!;
  return { directory, root, file, image, request, serve, style };
}

function creation(style: PosterStyle, changes: string, extra: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ styleId: style.id, styleSha256: style.crop.sha256, changes, ...extra }),
  };
}

function assertPublic(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const privateValue of [
    'originalStylePrompt',
    'combinedPrompt',
    'productionPlan',
    'composition',
    'observed',
    'reconstruction',
    recipeMarker,
    observedMarker,
  ])
    assert.equal(serialized.includes(privateValue), false, privateValue);
}

test('customer routes return safe styles and saved directions while storing complete stitching privately', async (t) => {
  const f = await fixture(t);
  const styles = posterStylesResponseSchema.parse(await (await f.request('/styles')).json());
  assert.equal(styles.styles.length, 1);
  assertPublic(styles);
  assert.deepEqual(Object.keys(f.style.crop).sort(), ['height', 'sha256', 'width']);
  for (const [path, init] of [
    ['/references', undefined],
    ['/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
  ] as const) {
    const response = await f.request(path, init);
    assert.equal(response.status, 404);
    assertPublic(await response.json());
  }
  const changes = 'Add the title Friday Notes.\nUse my venue name: Linden Cafe.';
  const response = await f.request('/designs', creation(f.style, changes));
  assert.equal(response.status, 201);
  const body = posterDesignResponseSchema.parse(await response.json());
  assert.equal(response.headers.get('location'), `/api/posters/designs/${body.design.id}`);
  assert.equal(body.design.status, 'prepared');
  assert.equal(body.design.changes, changes);
  assert.deepEqual(body.design.style, f.style);
  assertPublic(body);
  const storage = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(storage.schemaVersion, 1);
  assert.equal(storage.designs.length, 1);
  const record = storage.designs[0];
  assert.equal(record.changes, changes);
  assert.equal(record.originalStylePrompt.includes('Friday Notes'), false);
  assert.equal(record.combinedPrompt.startsWith(record.originalStylePrompt), true);
  assert.equal(
    JSON.parse(record.combinedPrompt.split('Customer additions (JSON):\n')[1]).changes,
    changes,
  );
  const source = JSON.parse(record.originalStylePrompt.split('Design source data (JSON):\n')[1]);
  assert.deepEqual(source.selectedReferences, [record.reference]);
  assert.deepEqual(record.reference.reconstruction.instructions, [recipeMarker]);
  assert.equal(record.reference.observed.layout, observedMarker);
  assert.equal(record.style.crop.sha256, f.style.crop.sha256);
  const loaded = await f.request(`/designs/${body.design.id}`);
  assert.equal(loaded.status, 200);
  assert.deepEqual(await loaded.json(), body);
});

test('saved directions survive a new router without regenerating or exposing private prompts', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/designs', creation(f.style, 'Add a small date line.'));
  const saved = posterDesignResponseSchema.parse(await response.json());
  const before = await readFile(f.file, 'utf8');
  const restarted = await f.serve();
  const reopened = await restarted(`/designs/${saved.design.id}`);
  assert.equal(reopened.status, 200);
  const body = await reopened.json();
  assert.deepEqual(body, saved);
  assertPublic(body);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('structured approved copy survives saves and restarts without exposing the private production plan', async (t) => {
  const f = await fixture(t);
  const brief = {
    copy: { headline: '  FRIDAY NOTES  ', details: 'NOV 28\nLINDEN CAFE' },
    canvas: { width: 1080, height: 1350 },
  };
  const response = await f.request(
    '/designs',
    creation(f.style, 'Keep the restrained layout.', { brief }),
  );
  assert.equal(response.status, 201);
  const body = posterDesignResponseSchema.parse(await response.json());
  assert.deepEqual(body.design.brief, brief);
  assertPublic(body);
  const stored = JSON.parse(await readFile(f.file, 'utf8')).designs[0];
  assert.deepEqual(stored.productionPlan.brief, brief);
  assert.equal(stored.productionPlan.reference.sha256, f.style.crop.sha256);
  assert.equal(stored.productionPlan.issues[0].code, 'missing-composition');
  const reopened = await f.serve();
  assert.deepEqual(await (await reopened(`/designs/${body.design.id}`)).json(), body);
});

test('historical directions without a production plan still open without rewriting storage', async (t) => {
  const f = await fixture(t);
  const created = await f.request('/designs', creation(f.style, 'Keep the original direction.'));
  const body = posterDesignResponseSchema.parse(await created.json());
  const storage = JSON.parse(await readFile(f.file, 'utf8'));
  delete storage.designs[0].productionPlan;
  const historical = JSON.stringify(storage);
  await writeFile(f.file, historical);
  const response = await f.request(`/designs/${body.design.id}`);
  assert.equal(response.status, 200);
  const reopened = posterDesignResponseSchema.parse(await response.json());
  assert.equal(reopened.design.brief, undefined);
  assert.equal(reopened.design.changes, body.design.changes);
  assert.equal(await readFile(f.file, 'utf8'), historical);
});

test('a changed persisted production plan fails closed without overwriting the saved direction', async (t) => {
  const f = await fixture(t);
  const created = await f.request('/designs', creation(f.style, 'Use a quiet layout.'));
  const body = posterDesignResponseSchema.parse(await created.json());
  const storage = JSON.parse(await readFile(f.file, 'utf8'));
  storage.designs[0].productionPlan.brief.copy.headline = 'Unexpected replacement';
  const changed = JSON.stringify(storage);
  await writeFile(f.file, changed);
  assert.equal((await f.request(`/designs/${body.design.id}`)).status, 500);
  assert.equal((await f.request('/designs', creation(f.style, 'Another direction.'))).status, 500);
  assert.equal(await readFile(f.file, 'utf8'), changed);
});

test('unknown, stale or malformed style submissions never create a stored direction', async (t) => {
  const f = await fixture(t);
  for (const [extra, status] of [
    [{ styleId: 'unknown-style' }, 404],
    [{ styleSha256: '0'.repeat(64) }, 409],
    [{ styleSha256: undefined }, 400],
    [{ changes: '' }, 400],
    [{ changes: 'x'.repeat(4001) }, 400],
    [{ originalStylePrompt: 'An attempted client-authored recipe.' }, 400],
    [{ combinedPrompt: 'An attempted client-authored combined prompt.' }, 400],
  ] as const) {
    const response = await f.request('/designs', creation(f.style, 'Add my event title.', extra));
    assert.equal(response.status, status);
    assertPublic(await response.json());
  }
  const changedImage = await sharp({
    create: { width: 12, height: 18, channels: 3, background: '#1234a9' },
  })
    .png()
    .toBuffer();
  await writeFile(join(f.root, 'crops', 'style-one.png'), changedImage);
  assert.equal((await f.request('/designs', creation(f.style, 'Add my event title.'))).status, 409);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  assert.equal((await f.request('/designs/not-a-uuid')).status, 400);
  assert.equal((await f.request(`/designs/${randomUUID()}`)).status, 404);
});

test('concurrent saves retain every accepted request and leave only atomic storage', async (t) => {
  const f = await fixture(t);
  const changes = Array.from({ length: 8 }, (_, i) => `Add event title ${i}.`);
  const responses = await Promise.all(
    changes.map((value) => f.request('/designs', creation(f.style, value))),
  );
  const saved = await Promise.all(
    responses.map(async (response) => {
      assert.equal(response.status, 201);
      return posterDesignResponseSchema.parse(await response.json()).design;
    }),
  );
  assert.equal(new Set(saved.map((design) => design.id)).size, changes.length);
  const storage = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(
    storage.designs.map((record: { changes: string }) => record.changes).sort(),
    [...changes].sort(),
  );
  assert.deepEqual(await readdir(dirname(f.file)), ['poster-designs.json']);
});

test('malformed private storage is preserved and a failed request does not poison later saves', async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.file), { recursive: true });
  const damaged = '{"schemaVersion":1,"designs":[';
  await writeFile(f.file, damaged);
  const failed = await f.request('/designs', creation(f.style, 'Add Friday Notes.'));
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, 'STORAGE_ERROR');
  assert.equal(await readFile(f.file, 'utf8'), damaged);
  await writeFile(f.file, JSON.stringify({ schemaVersion: 1, designs: [] }));
  assert.equal((await f.request('/designs', creation(f.style, 'Add Friday Notes.'))).status, 201);
});

test('bounded design capacity rejects another save without overwriting accepted designs', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/designs', creation(f.style, 'Add Friday Notes.'))).status, 201);
  const record = JSON.parse(await readFile(f.file, 'utf8')).designs[0];
  const full = JSON.stringify({
    schemaVersion: 1,
    designs: Array.from({ length: 250 }, () => ({ ...record, id: randomUUID() })),
  });
  await writeFile(f.file, full);
  const response = await f.request('/designs', creation(f.style, 'One more event.'));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'POSTER_DESIGN_LIMIT');
  assert.equal(await readFile(f.file, 'utf8'), full);
});

test('full app keeps private poster data beside project storage and never calls a paid provider', async (t) => {
  const f = await fixture(t);
  const appDirectory = join(f.directory, 'app-data');
  let providerCalls = 0;
  const blockedFetch: typeof fetch = async () => {
    providerCalls++;
    throw new Error('No provider calls are allowed.');
  };
  const app = await createApp({
    dataFile: join(appDirectory, 'projects.json'),
    workflowProviderConfig: { provider: 'guided' },
    posterReferencesDirectory: f.root,
    workflowFetch: blockedFetch,
    socialFetch: blockedFetch,
    creatorOptions: { fetch: blockedFetch },
  });
  const request = await f.serve(app);
  t.after(() => app.locals.shutdown());
  const response = await request('/designs', creation(f.style, 'Add the venue and Friday date.'));
  assert.equal(response.status, 201);
  assertPublic(await response.json());
  const storage = JSON.parse(await readFile(join(appDirectory, 'poster-designs.json'), 'utf8'));
  assert.equal(storage.designs.length, 1);
  assert.equal(storage.designs[0].changes, 'Add the venue and Friday date.');
  assert.equal(providerCalls, 0);
});
