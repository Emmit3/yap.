import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { projectResponseSchema, projectsResponseSchema, type Project } from '@yap/contracts';
import { createApp } from '../src/app.js';

const brief = {
  title: 'A better morning coffee',
  idea: 'Make a simple iced coffee at home using cold brew, oat milk, and a pinch of cinnamon.',
  audience: 'People making coffee at home',
  platform: 'tiktok',
  duration: 60,
  tone: 'bold',
  goal: 'promote',
} as const;

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-api-'));
  const file = join(directory, 'projects.json');
  let server: Server | undefined;
  async function start() {
    const app = await createApp({ dataFile: file });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  }
  let base = await start();
  t.after(async () => {
    if (server?.listening) await close(server);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    file,
    request(path: string, init?: RequestInit) {
      return fetch(`${base}/api${path}`, init);
    },
    async restart() {
      assert.ok(server);
      await close(server);
      base = await start();
    },
  };
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

async function create(
  f: Awaited<ReturnType<typeof fixture>>,
  input: unknown = brief,
): Promise<Project> {
  const response = await f.request('/projects', json('POST', input));
  assert.equal(response.status, 201);
  const { project } = projectResponseSchema.parse(await response.json());
  assert.equal(response.headers.get('location'), `/api/projects/${project.id}`);
  return project;
}

test('create, retrieve, list, sparse update, restart, and delete form a durable workflow', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request('/projects')).json(), { projects: [] });
  const project = await create(f);
  assert.equal(project.status, 'draft');
  assert.equal(project.draft, null);
  assert.equal((await f.request(`/projects/${project.id}`)).status, 200);

  const changed = await f.request(
    `/projects/${project.id}`,
    json('PATCH', { title: 'Coffee that tastes better' }),
  );
  assert.equal(changed.status, 200);
  const { project: updated } = projectResponseSchema.parse(await changed.json());
  assert.equal(updated.title, 'Coffee that tastes better');
  assert.equal(updated.platform, 'tiktok');
  assert.equal(updated.duration, 60);
  assert.equal(updated.tone, 'bold');
  assert.equal(updated.goal, 'promote');
  await f.restart();
  const listed = projectsResponseSchema.parse(await (await f.request('/projects')).json());
  assert.equal(listed.projects.length, 1);
  assert.deepEqual(listed.projects[0], updated);
  assert.equal((await f.request(`/projects/${project.id}`, { method: 'DELETE' })).status, 204);
  await f.restart();
  assert.deepEqual(await (await f.request('/projects')).json(), { projects: [] });
  assert.equal((await f.request(`/projects/${project.id}`)).status, 404);
});

test('guided drafting respects duration and supplied idea, and editing preserves provenance', async (t) => {
  const f = await fixture(t);
  for (const duration of [15, 30, 60]) {
    const project = await create(f, { ...brief, duration });
    const response = await f.request(`/projects/${project.id}/generate`, { method: 'POST' });
    assert.equal(response.status, 200);
    const { project: generated } = projectResponseSchema.parse(await response.json());
    assert.ok(generated.draft);
    assert.equal(generated.draft.provider, 'guided');
    assert.equal(
      generated.draft.shots.reduce((sum, shot) => sum + shot.seconds, 0),
      duration,
    );
    assert.match(generated.draft.script, /iced coffee/);
    const { provider, generatedAt, ...content } = generated.draft;
    const edited = await f.request(
      `/projects/${project.id}`,
      json('PATCH', {
        draft: { ...content, hook: 'An edited opening line', script: 'A custom recording script.' },
        status: 'ready',
      }),
    );
    assert.equal(edited.status, 200);
    const { project: saved } = projectResponseSchema.parse(await edited.json());
    assert.equal(saved.draft?.hook, 'An edited opening line');
    assert.equal(saved.draft?.script, 'A custom recording script.');
    assert.equal(saved.draft?.provider, provider);
    assert.equal(saved.draft?.generatedAt, generatedAt);
    assert.equal(saved.status, 'ready');
  }
});

test('brief edits invalidate stale plans, and ready requires a valid draft', async (t) => {
  const f = await fixture(t);
  const project = await create(f);
  const premature = await f.request(`/projects/${project.id}`, json('PATCH', { status: 'ready' }));
  assert.equal(premature.status, 409);
  assert.equal((await premature.json()).error.code, 'DRAFT_REQUIRED');
  await f.request(`/projects/${project.id}/generate`, { method: 'POST' });
  const changed = await f.request(
    `/projects/${project.id}`,
    json('PATCH', { idea: 'Use decaf coffee for a calmer afternoon drink.' }),
  );
  assert.equal(changed.status, 200);
  const { project: saved } = projectResponseSchema.parse(await changed.json());
  assert.equal(saved.draft, null);
  assert.equal(saved.status, 'draft');
});

test('shot edits reject timing mismatches without changing the saved draft', async (t) => {
  const f = await fixture(t);
  const project = await create(f);
  const { project: generated } = projectResponseSchema.parse(
    await (await f.request(`/projects/${project.id}/generate`, { method: 'POST' })).json(),
  );
  assert.ok(generated.draft);
  const { provider: _provider, generatedAt: _generatedAt, ...content } = generated.draft;
  const changed = {
    ...content,
    shots: content.shots.map((shot, index) =>
      index === 0 ? { ...shot, seconds: shot.seconds + 1 } : shot,
    ),
  };
  const response = await f.request(`/projects/${project.id}`, json('PATCH', { draft: changed }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_SHOT_DURATION');
  const { project: unchanged } = projectResponseSchema.parse(
    await (await f.request(`/projects/${project.id}`)).json(),
  );
  assert.deepEqual(unchanged.draft, generated.draft);
});

test('exports include the actual saved plan and provide safe attachment filenames', async (t) => {
  const f = await fixture(t);
  const project = await create(f, { ...brief, title: 'Coffee / a fresh start ☕' });
  const empty = await f.request(`/projects/${project.id}/export`);
  assert.match(await empty.text(), /No script or shot plan/);
  const { project: generated } = projectResponseSchema.parse(
    await (await f.request(`/projects/${project.id}/generate`, { method: 'POST' })).json(),
  );
  const markdown = await f.request(`/projects/${project.id}/export?format=markdown`);
  assert.equal(markdown.status, 200);
  assert.match(markdown.headers.get('content-disposition') ?? '', /coffee-a-fresh-start\.md/);
  assert.match(markdown.headers.get('content-type') ?? '', /text\/markdown/);
  const text = await markdown.text();
  assert.ok(text.includes(generated.draft!.script));
  assert.match(text, /Shot 1/);
  const exported = await f.request(`/projects/${project.id}/export?format=json`);
  assert.deepEqual(projectResponseSchema.parse(await exported.json()).project, generated);
  assert.equal((await f.request(`/projects/${project.id}/export?format=mp4`)).status, 400);
});

test('input, malformed JSON, unknown routes, and missing IDs return structured errors', async (t) => {
  const f = await fixture(t);
  const invalid = await f.request(
    '/projects',
    json('POST', { title: '', idea: 'tiny', audience: 'a', unexpected: true }),
  );
  assert.equal(invalid.status, 400);
  const error = (await invalid.json()).error;
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.ok(error.details.some((detail: { path: string }) => detail.path === 'idea'));
  assert.equal((await f.request('/projects/not-a-uuid')).status, 400);
  assert.equal((await f.request(`/projects/${randomUUID()}`)).status, 404);
  assert.equal((await f.request('/missing')).status, 404);
  const broken = await f.request('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{broken',
  });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error.code, 'INVALID_JSON');
  const oversized = await f.request(
    '/projects',
    json('POST', { ...brief, idea: 'x'.repeat(140_000) }),
  );
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'BODY_TOO_LARGE');
  const project = await create(f);
  assert.equal((await f.request(`/projects/${project.id}`, json('PATCH', {}))).status, 400);
});

test('CORS permits only the configured browser origin and health reports guided generation', async (t) => {
  const f = await fixture(t);
  const allowed = await f.request('/health', { headers: { Origin: 'http://127.0.0.1:5173' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  assert.deepEqual(await allowed.json(), { status: 'ok', service: 'yap-api', generator: 'guided' });
  const denied = await f.request('/health', { headers: { Origin: 'https://unrelated.example' } });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('drafting rejects array payloads and handles maximum length input without internal errors', async (t) => {
  const f = await fixture(t);
  const project = await create(f, { ...brief, title: 'a'.repeat(120), idea: 'a'.repeat(4000) });
  const array = await f.request(`/projects/${project.id}/generate`, json('POST', []));
  assert.equal(array.status, 400);
  const response = await f.request(`/projects/${project.id}/generate`, { method: 'POST' });
  assert.equal(response.status, 200);
  const generated = projectResponseSchema.parse(await response.json()).project;
  assert.equal(
    generated.draft?.shots.reduce((sum, shot) => sum + shot.seconds, 0),
    project.duration,
  );
});

test('concurrent saves survive a restart without losing projects', async (t) => {
  const f = await fixture(t);
  const created = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      create(f, { ...brief, title: `Coffee concept ${index + 1}` }),
    ),
  );
  await f.restart();
  const { projects } = projectsResponseSchema.parse(await (await f.request('/projects')).json());
  assert.equal(projects.length, 10);
  assert.deepEqual(
    new Set(projects.map((project) => project.id)),
    new Set(created.map((project) => project.id)),
  );
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).length, 10);
});

test('corrupted existing storage fails startup and is preserved for recovery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yap-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'projects.json');
  await writeFile(file, '{broken', 'utf8');
  await assert.rejects(createApp({ dataFile: file }), /Restore a valid data file/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
