import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectResponseSchema } from '@yap/contracts';
import { socialHandoffSchema, socialInvestigationResponseSchema } from '@yap/contracts/social';
import { createApp } from '../src/app.js';

test('saved research decisions influence a persistent script through the integrated HTTP app', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yap-social-integration-'));
  const app = await createApp({ dataFile: join(directory, 'projects.json'), socialProviderConfig: {} });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await app.locals.shutdown?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const send = (path: string, body: unknown, method = 'POST') => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const created = await send('/social/investigations', { topic: 'Coffee education', mode: 'demo', platforms: ['x'], limit: 20 });
  assert.equal(created.status, 201);
  const { investigation } = socialInvestigationResponseSchema.parse(await created.json());
  const evidenceId = investigation.analysis.posts[0]!.id;
  const saved = await send(`/social/investigations/${investigation.id}/notes`, {
    text: 'Open with one clear question and answer it using our own verified information.',
    kind: 'adopt', evidenceIds: [evidenceId],
  });
  assert.equal(saved.status, 201);
  const withNote = socialInvestigationResponseSchema.parse(await saved.json()).investigation;
  const handoffResponse = await send(`/social/investigations/${investigation.id}/handoff`, {
    noteIds: [withNote.notes[0]!.id], insightIds: [],
  });
  assert.equal(handoffResponse.status, 200);
  const handoff = socialHandoffSchema.parse(await handoffResponse.json());
  assert.equal(handoff.sourceUrls.length, 1);
  const projectResponse = await send('/projects', {
    title: 'Our reusable filter', idea: 'Show our reusable coffee filter and explain how to rinse it after use.',
    audience: 'People making coffee at home', research: handoff,
  });
  assert.equal(projectResponse.status, 201);
  const { project } = projectResponseSchema.parse(await projectResponse.json());
  const generated = await send(`/projects/${project.id}/generate`, {});
  assert.equal(generated.status, 200);
  const current = projectResponseSchema.parse(await generated.json()).project;
  assert.match(current.draft!.hook, /^What should you know/);
  assert.deepEqual(current.research, handoff);
  const markdown = await (await fetch(`${base}/projects/${project.id}/export`)).text();
  assert.match(markdown, /Research direction/);
  assert.ok(markdown.includes(handoff.sourceUrls[0]!));
  const changed = await send(`/projects/${project.id}`, {
    research: { ...handoff, creativeDirection: 'Adopt: Show a demonstration first.' },
  }, 'PATCH');
  assert.equal(changed.status, 200);
  assert.equal(projectResponseSchema.parse(await changed.json()).project.draft, null);
  const reopened = await createApp({ dataFile: join(directory, 'projects.json'), socialProviderConfig: {} });
  await reopened.locals.shutdown?.();
});
