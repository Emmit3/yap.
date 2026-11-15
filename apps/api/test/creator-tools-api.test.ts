import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, type TestContext } from 'node:test';
import sharp from 'sharp';
import type { CreatorVideoProvider } from '../src/creator-video-provider.js';
import { createApp } from '../src/app.js';
import { runProductionFfmpeg } from '../src/creator-production-storage.js';
import { editDuration } from '@yap/contracts/production';

// These HTTP fixtures never inherit an account key or use a paid provider.
const keyNames = [
  'OPENAI_API_KEY',
  'DEEPAGENTS_OPENAI_API_KEY',
  'FAL_KEY',
  'RUNWAYML_API_SECRET',
  'FIRECRAWL_API_KEY',
  'XAI_API_KEY',
  'X_BEARER_TOKEN',
];
const priorKeys = new Map(keyNames.map((key) => [key, process.env[key]]));
for (const key of keyNames) delete process.env[key];
after(() => {
  for (const [key, value] of priorKeys) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
async function value(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-tools-http-'));
  let externalCalls = 0,
    generated = 0,
    reviewed = 0;
  const rejectExternal: typeof fetch = async () => {
    externalCalls++;
    throw Error('External provider requests are disabled in HTTP fixtures.');
  };
  const video: CreatorVideoProvider = {
    configured: true,
    profile: {
      id: 'runway-gen4.5-portrait',
      provider: 'runway',
      model: 'gen4.5',
      ratio: '720:1280',
      nativeWidth: 720,
      nativeHeight: 1280,
      minSeconds: 2,
      maxSeconds: 10,
      rateCentsPerSecond: 16,
      priceSourceUrl: 'https://example.com/fixture-no-billing',
      pricingCheckedAt: '2026-11-15',
    },
    cancel: async () => {},
    generate: async ({ clip, beforeSubmit, onSubmitted, signal }) => {
      signal.throwIfAborted();
      await beforeSubmit?.();
      await onSubmitted(`fixture-${randomUUID()}`);
      generated++;
      const path = join(directory, `clip-${generated}.mp4`);
      await runProductionFfmpeg(
        [
          '-f',
          'lavfi',
          '-i',
          `color=c=${generated % 2 ? '0x234b58' : '0xb89c72'}:s=720x1280:r=24:d=${clip.seconds}`,
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
        signal,
        directory,
      );
      return readFile(path);
    },
  };
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    workflowProviderConfig: { provider: 'guided' },
    workflowFetch: rejectExternal,
    socialFetch: rejectExternal,
    creatorOptions: {
      fetch: rejectExternal,
      video,
      videoProviders: new Map([['runway-gen4.5-portrait', video]]),
      auditor: {
        configured: true,
        audit: async (_clip, frames) => {
          reviewed++;
          assert.equal(frames.length, 3);
          return {
            technicalPassed: true,
            visionPassed: true,
            summary: 'Injected fixture review, not live model analysis.',
            issues: [],
          };
        },
      },
    },
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
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(directory).startsWith('yap-tools-http-'));
    await rm(directory, { recursive: true, force: true });
    assert.equal(externalCalls, 0);
  });
  const logo = await sharp({
    create: { width: 20, height: 20, channels: 4, background: '#247b58' },
  })
    .png()
    .toBuffer();
  await writeFile(join(directory, 'sample-logo.png'), logo);
  return {
    directory,
    logo,
    request: (path: string, init?: RequestInit) => fetch(base + path, init),
    counts: () => ({ generated, reviewed, externalCalls }),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function session(f: Fixture) {
  return value(
    await f.request(
      '/sessions',
      json('POST', {
        input: {
          mode: 'text',
          prompt: 'A calm ceramic cup with care in every detail.',
          duration: 15,
          urls: [],
        },
      }),
    ),
    201,
  );
}
const brandInput = {
  name: 'Mori Demo',
  font: 'sans',
  inkColor: '#172b26',
  paperColor: '#ffffff',
  accentColor: '#247b58',
  endCard: {
    enabled: true,
    title: 'Make a quiet moment',
    detail: 'A local HTTP fixture.',
    seconds: 1,
  },
};

test('brand HTTP settings, raw logo and optimistic conflicts preserve normalized receipts', async (t) => {
  const f = await fixture(t);
  const initial = await value(await f.request('/brand'));
  assert.equal(initial.brand.version, 0);
  const changed = await value(
    await f.request('/brand', json('PATCH', { expectedVersion: 0, brand: brandInput })),
  );
  assert.equal(changed.brand.version, 1);
  assert.equal(changed.brand.inkColor, '#172b26');
  assert.equal(
    (await f.request('/brand', json('PATCH', { expectedVersion: 0, brand: brandInput }))).status,
    409,
  );
  const uploaded = await value(
    await f.request('/brand/logo?expectedVersion=1', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: f.logo,
    }),
  );
  assert.equal(uploaded.brand.version, 2);
  assert.equal(uploaded.snapshot.logo.width, 20);
  const logo = await f.request(`/brand/logo/${uploaded.snapshot.logo.sha256}.png`);
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type') ?? '', /image\/png/);
  assert.equal((await logo.arrayBuffer()).byteLength, uploaded.snapshot.logo.bytes);
  assert.equal(logo.headers.get('cache-control'), 'private, no-store');
  assert.equal(
    (
      await f.request('/brand/logo?expectedVersion=1', {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: f.logo,
      })
    ).status,
    409,
  );
});

test('invalid JSON and malformed media return actionable HTTP errors without changing the brand', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request('/brand', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{"expectedVersion":',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/brand',
        json('PATCH', { expectedVersion: 0, brand: { ...brandInput, inkColor: 'red' } }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/brand/logo?expectedVersion=0', {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: Buffer.from('not an image'),
      })
    ).status,
    422,
  );
  assert.equal((await value(await f.request('/brand'))).brand.version, 0);
});

test('creation ownership is checked before saved image and reference lookups', async (t) => {
  const f = await fixture(t),
    missing = randomUUID();
  for (const path of [
    `/sessions/${missing}/images`,
    `/sessions/${missing}/reference-analysis`,
    `/sessions/${missing}/edits`,
  ])
    assert.equal((await f.request(path)).status, 404, path);
});

test('reference HTTP imports, raw frames and manual notes stay scoped and guarded', async (t) => {
  const f = await fixture(t),
    first = await session(f),
    other = await session(f),
    base = `/sessions/${first.session.id}/reference-analysis`;
  const imported = await value(
    await f.request(
      base,
      json('POST', {
        title: 'Supplied reference',
        sourceUrl: 'https://example.com/film',
        format: 'srt',
        transcript: '1\n00:00:01,000 --> 00:00:04,000\nAn opening detail.',
      }),
    ),
    201,
  );
  assert.equal(imported.reference.provenance, 'attributed_external_reference');
  assert.equal(imported.reference.analysis, undefined);
  const path = `${base}/${imported.reference.id}`;
  const framed = await value(
    await f.request(`${path}/frames?expectedVersion=1&atSeconds=2`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: f.logo,
    }),
  );
  assert.equal(framed.reference.version, 2);
  assert.equal(framed.reference.frames.length, 1);
  assert.equal(framed.reference.frames[0].atSeconds, 2);
  assert.equal(
    (
      await f.request(`${path}/frames?expectedVersion=1&atSeconds=2`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: f.logo,
      })
    ).status,
    409,
  );
  const noted = await value(
    await f.request(
      `${path}/observations`,
      json('POST', { expectedVersion: 2, text: 'Adopt the patient opening rhythm.', atSeconds: 2 }),
    ),
  );
  assert.equal(noted.reference.observations[0].origin, 'creator');
  const frame = framed.reference.frames[0],
    download = await f.request(`${path}/frames/${frame.id}/image`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /image\/jpeg/);
  assert.equal((await download.arrayBuffer()).byteLength, frame.bytes);
  assert.equal(
    (await f.request(`/sessions/${other.session.id}/reference-analysis/${imported.reference.id}`))
      .status,
    404,
  );
  assert.equal(
    (
      await f.request(
        `/sessions/${other.session.id}/reference-analysis/${imported.reference.id}/frames/${frame.id}/image`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(
        `${path}/analyze`,
        json('POST', {
          expectedVersion: noted.reference.version,
          sourceHash: noted.reference.sourceHash,
          requestId: randomUUID(),
          reviewed: true,
          costReviewed: true,
          maxCostCents: 50,
        }),
      )
    ).status,
    503,
  );
});

test('unconfigured storyboard quotes fail without reserving money or submitting providers', async (t) => {
  const f = await fixture(t),
    created = await session(f),
    before = await value(await f.request('/budget'));
  const images = await value(await f.request(`/sessions/${created.session.id}/images`));
  assert.equal(images.configured, false);
  assert.deepEqual(images.images, []);
  const result = await f.request(
    `/sessions/${created.session.id}/images/quote`,
    json('POST', {
      prompt: 'A calm ceramic cup.',
      purpose: 'storyboard',
      sessionVersion: created.session.version,
      workflowVersion: created.workflow.version,
    }),
  );
  assert.equal(result.status, 503);
  assert.deepEqual(await value(await f.request('/budget')), before);
  assert.deepEqual(f.counts(), { generated: 0, reviewed: 0, externalCalls: 0 });
});

test(
  'approved native production burns subtitles and brand, then free timeline edits preserve generation receipts',
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t);
    await value(
      await f.request('/brand', json('PATCH', { expectedVersion: 0, brand: brandInput })),
    );
    const brand = await value(
      await f.request('/brand/logo?expectedVersion=1', {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: f.logo,
      }),
    );
    let current = await session(f);
    current = await value(
      await f.request(
        `/sessions/${current.session.id}/prepare`,
        json('POST', {
          expectedVersion: current.session.version,
          expectedWorkflowVersion: current.workflow.version,
        }),
      ),
    );
    const plan = current.session.plan;
    current = await value(
      await f.request(
        `/sessions/${current.session.id}/plan`,
        json('PATCH', {
          expectedVersion: current.session.version,
          expectedWorkflowVersion: current.workflow.version,
          clips: plan.clips.map((clip: object) => ({
            ...clip,
            videoProfileId: 'runway-gen4.5-portrait',
          })),
          caption: plan.caption,
          subtitlesEnabled: true,
          outputProfileId: 'portrait-720',
          brandSnapshot: brand.snapshot,
        }),
      ),
    );
    assert.equal(current.session.plan.brandSnapshot.sha256, brand.snapshot.sha256);
    const { quote } = await value(
      await f.request(
        `/sessions/${current.session.id}/quote`,
        json('POST', {
          expectedVersion: current.session.version,
          expectedWorkflowVersion: current.workflow.version,
        }),
      ),
    );
    assert.equal(quote.outputProfileId, 'portrait-720');
    assert.equal(quote.brandSnapshot.sha256, brand.snapshot.sha256);
    current = await value(
      await f.request(
        `/sessions/${current.session.id}/approve`,
        json('POST', {
          expectedVersion: current.session.version,
          expectedWorkflowVersion: current.workflow.version,
          planId: current.session.plan.id,
          quoteId: quote.id,
          reviewed: true,
          costReviewed: true,
        }),
      ),
    );
    const started = await value(
      await f.request(
        `/sessions/${current.session.id}/produce`,
        json('POST', {
          expectedVersion: current.session.version,
          approvalId: current.session.approval.id,
          quoteId: quote.id,
          requestId: randomUUID(),
        }),
      ),
      202,
    );
    const jobPath = `/sessions/${current.session.id}/jobs/${started.job.id}`;
    let finished = started;
    for (let attempt = 0; attempt < 1200; attempt++) {
      finished = await value(await f.request(jobPath));
      if (['succeeded', 'failed', 'canceled'].includes(finished.job.status)) break;
      await delay(100);
    }
    assert.equal(finished.job.status, 'succeeded', JSON.stringify(finished.job.error));
    assert.equal(finished.job.output.width, 720);
    assert.equal(finished.job.output.height, 1280);
    assert.equal(finished.job.output.outputProfileId, 'portrait-720');
    assert.equal(finished.job.output.resized, false);
    assert.ok(finished.job.output.subtitles);
    const source = await f.request(`${jobPath}/video`);
    assert.equal(source.status, 200);
    assert.equal((await source.arrayBuffer()).byteLength, finished.job.output.bytes);
    assert.equal((await f.request(`${jobPath}/subtitles.srt`)).status, 200);
    const beforeJob = structuredClone(finished.job),
      beforeCalls = f.counts();
    await delay(100);
    const beforeBudget = await value(await f.request('/budget'));
    const created = await value(
        await f.request(
          `/sessions/${current.session.id}/edits`,
          json('POST', { jobId: started.job.id }),
        ),
        201,
      ),
      editPath = `/sessions/${current.session.id}/edits/${created.edit.id}`;
    const draft = structuredClone(created.edit.draft);
    draft.segments.reverse();
    draft.segments = draft.segments.slice(0, 2);
    for (const segment of draft.segments) {
      segment.trimIn = 0;
      segment.trimOut = 3;
    }
    draft.segments[0].transition = 'dissolve';
    draft.segments[0].transitionSeconds = 0.25;
    draft.brand = brand.snapshot;
    draft.textLayers = [
      {
        id: randomUUID(),
        text: 'A revised local edit',
        start: 0,
        end: 2,
        x: 0.5,
        y: 0.2,
        fontSize: 32,
        color: '#ffffff',
      },
    ];
    const updated = await value(
      await f.request(editPath, json('PATCH', { expectedVersion: 1, draft })),
    );
    assert.equal(updated.edit.version, 2);
    assert.equal(
      (await f.request(editPath, json('PATCH', { expectedVersion: 1, draft }))).status,
      409,
    );
    assert.equal(
      (await f.request(`${editPath}/render`, json('POST', { expectedVersion: 2, reviewed: false })))
        .status,
      400,
    );
    const rendered = await value(
      await f.request(`${editPath}/render`, json('POST', { expectedVersion: 2, reviewed: true })),
    );
    assert.ok(Math.abs(rendered.render.duration - editDuration(draft)) < 1 / 24 + 0.001);
    assert.equal(rendered.render.width, 720);
    assert.equal(rendered.render.height, 1280);
    const download = await f.request(`${editPath}/renders/${rendered.render.id}/video?download=1`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
    assert.match(download.headers.get('content-disposition') ?? '', /yap-edited-film\.mp4/);
    assert.equal((await download.arrayBuffer()).byteLength, rendered.render.bytes);
    const range = await f.request(`${editPath}/renders/${rendered.render.id}/video`, {
      headers: { Range: 'bytes=0-31' },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 32);
    const history = await value(await f.request(`${editPath}/history`));
    assert.equal(history.history.length, 2);
    assert.deepEqual((await value(await f.request(jobPath))).job, beforeJob);
    assert.deepEqual(f.counts(), beforeCalls);
    assert.deepEqual(await value(await f.request('/budget')), beforeBudget);
  },
);
