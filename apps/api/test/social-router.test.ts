import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import {
  socialHandoffSchema,
  socialInvestigationResponseSchema,
  socialInvestigationsResponseSchema,
  socialProvidersResponseSchema,
  socialQueryResponseSchema,
  socialResearchInputSchema,
} from '@yap/contracts/social';
import { ApiError, StorageError } from '../src/errors.js';
import { buildDemoSocialDataset } from '../src/social-providers.js';
import { SocialRepository } from '../src/social-repository.js';
import { createSocialRouter } from '../src/social-router.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-social-'));
  const file = join(directory, 'research.json');
  let server: Server;
  let base = '';
  async function close() {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  async function start() {
    const app = express();
    app.use(express.json({ limit: '128kb' }));
    app.use('/api/social', await createSocialRouter({ dataFile: file, config: {} }));
    const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
      response
        .status(error instanceof ApiError ? error.status : 500)
        .json({
          error: {
            code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Failed',
          },
        });
    };
    app.use(errors);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}/api/social`;
  }
  await start();
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    file,
    request: (path: string, method = 'GET', body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      }),
    restart: async () => {
      await close();
      await start();
    },
  };
}

const brief = {
  topic: 'Simple coffee experiments',
  audience: 'Beginner home brewers',
  platforms: ['x'],
  mode: 'demo',
  limit: 12,
};

test('investigations and evidence-backed notes persist through restarts, with sparse editing and deletion', async (t) => {
  const f = await fixture(t);
  const providers = socialProvidersResponseSchema.parse(
    await (await f.request('/providers')).json(),
  );
  assert.ok(providers.providers.every((provider) => !provider.configured));
  assert.deepEqual(
    socialInvestigationsResponseSchema.parse(await (await f.request('/investigations')).json())
      .investigations,
    [],
  );
  const created = await f.request('/investigations', 'POST', brief);
  assert.equal(created.status, 201);
  const { investigation } = socialInvestigationResponseSchema.parse(await created.json());
  assert.equal(created.headers.get('location'), `/api/social/investigations/${investigation.id}`);
  assert.equal(investigation.analysis.posts.length, 12);
  const postId = investigation.analysis.posts[0]!.id;
  const noteResponse = await f.request(`/investigations/${investigation.id}/notes`, 'POST', {
    text: 'Test a comparison hook, then show one concrete example.',
    kind: 'test',
    evidenceIds: [postId],
  });
  assert.equal(noteResponse.status, 201);
  const { investigation: withNote } = socialInvestigationResponseSchema.parse(
    await noteResponse.json(),
  );
  const noteId = withNote.notes[0]!.id;
  const patch = await f.request(`/investigations/${investigation.id}/notes/${noteId}`, 'PATCH', {
    kind: 'adopt',
  });
  assert.equal(patch.status, 200);
  const { investigation: changed } = socialInvestigationResponseSchema.parse(await patch.json());
  assert.deepEqual(changed.notes[0]!.evidenceIds, [postId]);
  assert.equal(changed.notes[0]!.text, withNote.notes[0]!.text);
  await f.restart();
  const { investigation: reloaded } = socialInvestigationResponseSchema.parse(
    await (await f.request(`/investigations/${investigation.id}`)).json(),
  );
  assert.deepEqual(reloaded.notes, changed.notes);
  const handoffResponse = await f.request(`/investigations/${investigation.id}/handoff`, 'POST', {
    noteIds: [noteId],
    insightIds: [],
  });
  assert.equal(handoffResponse.status, 200);
  const handoff = socialHandoffSchema.parse(await handoffResponse.json());
  assert.deepEqual(handoff.selectedNoteIds, [noteId]);
  assert.ok(handoff.evidence.some((item) => item.postId === postId));
  const deletedNote = await f.request(
    `/investigations/${investigation.id}/notes/${noteId}`,
    'DELETE',
  );
  assert.equal(
    socialInvestigationResponseSchema.parse(await deletedNote.json()).investigation.notes.length,
    0,
  );
  assert.equal((await f.request(`/investigations/${investigation.id}`, 'DELETE')).status, 204);
  await f.restart();
  assert.equal((await f.request(`/investigations/${investigation.id}`)).status, 404);
});

test('query returns bounded citations and handoff requires explicit valid selections', async (t) => {
  const f = await fixture(t);
  const { investigation } = socialInvestigationResponseSchema.parse(
    await (await f.request('/investigations', 'POST', brief)).json(),
  );
  const queried = await f.request(`/investigations/${investigation.id}/query`, 'POST', {
    question: 'What comparison patterns can we test for beginners?',
  });
  assert.equal(queried.status, 200);
  const answer = socialQueryResponseSchema.parse(await queried.json());
  assert.ok(answer.evidence.length <= 12);
  assert.ok(
    answer.evidence.every((item) =>
      investigation.analysis.posts.some((post) => post.id === item.postId),
    ),
  );
  assert.equal(
    (await f.request(`/investigations/${investigation.id}/handoff`, 'POST', {})).status,
    400,
  );
  assert.equal(
    (
      await f.request(`/investigations/${investigation.id}/handoff`, 'POST', {
        insightIds: ['missing'],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(`/investigations/${investigation.id}/notes`, 'POST', {
        text: 'Unbacked note',
        kind: 'context',
        evidenceIds: ['missing'],
      })
    ).status,
    400,
  );
  const insightId = investigation.analysis.insights[0]!.id;
  const handoff = await f.request(`/investigations/${investigation.id}/handoff`, 'POST', {
    insightIds: [insightId],
  });
  assert.equal(handoff.status, 200);
  assert.deepEqual(socialHandoffSchema.parse(await handoff.json()).selectedInsightIds, [insightId]);
});

test('live search without compatible credentials fails clearly and does not persist demo data', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/investigations', 'POST', { ...brief, mode: 'live' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'SOCIAL_NOT_CONFIGURED');
  assert.deepEqual(
    socialInvestigationsResponseSchema.parse(await (await f.request('/investigations')).json())
      .investigations,
    [],
  );
});

test('public import validates platform URLs and references, requires attestation, and marks source provenance', async (t) => {
  const f = await fixture(t);
  const input = socialResearchInputSchema.parse({ ...brief, mode: 'live', limit: 6 });
  const sample = buildDemoSocialDataset(input);
  const dataset = {
    ...sample,
    posts: sample.posts.map((post, index) => ({
      ...post,
      url: `https://x.com/publiccreator/status/${1000 + index}`,
    })),
  };
  assert.equal((await f.request('/investigations/import', 'POST', { input, dataset })).status, 400);
  assert.equal(
    (
      await f.request('/investigations/import', 'POST', {
        input,
        dataset: { ...dataset, posts: [{ ...dataset.posts[0], url: 'https://127.0.0.1/private' }] },
        publicDataOnly: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/investigations/import', 'POST', {
        input,
        dataset: {
          ...dataset,
          relationships: [{ ...dataset.relationships[0], targetPostId: 'missing' }],
        },
        publicDataOnly: true,
      })
    ).status,
    400,
  );
  const response = await f.request('/investigations/import', 'POST', {
    input,
    dataset,
    publicDataOnly: true,
  });
  assert.equal(response.status, 201);
  const { investigation } = socialInvestigationResponseSchema.parse(await response.json());
  assert.ok(investigation.analysis.posts.every((post) => post.provider === 'import'));
  assert.equal(investigation.mode, 'live');
});

test('corrupt research storage is preserved and refused rather than reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yap-social-corrupt-'));
  const file = join(directory, 'research.json');
  try {
    await writeFile(file, '{broken storage');
    await assert.rejects(SocialRepository.open(file), StorageError);
    assert.equal(await readFile(file, 'utf8'), '{broken storage');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
