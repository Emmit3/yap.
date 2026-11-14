// Browserless manual smoke: node --import tsx scripts/test-promo-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../apps/api/src/app.ts';
import { createPromoApi } from '../apps/web/src/promo/api.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'yap-frontend-promo-smoke-'));
let app;
let server;

try {
  app = await createApp({
    dataFile: join(temporary, 'projects.json'),
    workflowDataFile: join(temporary, 'workflows.json'),
    assetsDirectory: join(temporary, 'photos'),
    rendersDirectory: join(temporary, 'renders'),
    workflowProviderConfig: { provider: 'guided' },
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const api = createPromoApi(`http://127.0.0.1:${address.port}`);

  console.log('Creating a guided promo through the frontend client.');
  let state = await api.create({
    title: 'Frontend product photo smoke',
    input:
      'Create a friendly weekend promo for our neighborhood drinks shop using the supplied product photo.',
    brief: {
      productName: 'Mori Drinks',
      productDescription: 'A neighborhood drinks shop serving refreshing drinks.',
      audience: 'Neighbors looking for an afternoon break',
      keyBenefits: ['Refreshing drinks', 'A place to meet friends'],
      callToAction: 'Visit Mori Drinks this weekend.',
      imageDirection: 'Use the supplied product photograph without inventing another product.',
      platform: 'instagram',
      duration: 15,
      tone: 'conversational',
    },
  });
  const id = state.workflow.id;
  const photo = await readFile(join(root, 'public/media/wall-beverage.jpg'));
  state = await api.upload(
    id,
    state.workflow.version,
    new File([photo], 'Our drink.jpg', { type: 'image/jpeg' }),
  );
  state = await api.prepare(id, { expectedVersion: state.workflow.version });
  assert.deepEqual(state.workflow.approvals, { brief: null, script: null, scenes: null });
  console.log('Proposal prepared without approval; explicitly accepting this smoke fixture.');
  state = await api.approveAll(id, state.workflow.version);
  const job = await api.render(id, state.workflow.version);
  let previousStatus;
  const completed = await api.waitForRender(id, job.id, {
    intervalMs: 500,
    timeoutMs: 120_000,
    onUpdate(update) {
      if (update.status !== previousStatus) console.log(`Render: ${update.status}`);
      previousStatus = update.status;
    },
  });
  assert.equal(completed.status, 'succeeded', completed.error?.message);
  const kit = await api.getPublishKit(id);
  assert.equal(kit.workflowVersion, state.workflow.version);
  assert.equal(kit.video.jobId, completed.id);
  assert.equal(kit.ready, true);
  assert.equal(kit.automaticPosting, false);
  const download = await fetch(api.videoUrl(id, completed.id, true));
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /video\/mp4/);
  assert.equal(download.headers.get('x-yap-source-stale'), 'false');
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.subarray(4, 8).toString('ascii'), 'ftyp');
  const artifact = join(root, 'artifacts/frontend-promo-smoke.mp4');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(artifact, bytes);

  const encoder = createRequire(new URL('../apps/api/package.json', import.meta.url))(
    'ffmpeg-static',
  );
  assert.equal(typeof encoder, 'string');
  const diagnostics = await new Promise((resolveOutput, reject) => {
    const child = spawn(encoder, ['-hide_banner', '-i', artifact, '-t', '0.1', '-f', 'null', '-'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolveOutput(stderr) : reject(new Error(stderr))));
  });
  assert.match(diagnostics, /Duration: 00:00:15\.00/);
  assert.match(diagnostics, /Video: h264/);
  assert.match(diagnostics, /1080x1920/);
  assert.match(diagnostics, /24 fps/);
  assert.doesNotMatch(diagnostics, /Audio:/);
  console.log(
    JSON.stringify(
      {
        artifact,
        bytes: bytes.length,
        codec: 'H.264',
        dimensions: '1080x1920',
        durationSeconds: 15,
        fps: 24,
        hasAudio: false,
        currentPublishKit: kit.ready,
      },
      null,
      2,
    ),
  );
} finally {
  await app?.locals.shutdown();
  if (server?.listening)
    await new Promise((resolveStop, reject) =>
      server.close((error) => (error ? reject(error) : resolveStop())),
    );
  const cleanupTarget = resolve(temporary);
  assert.ok(
    cleanupTarget.startsWith(resolve(tmpdir()) + sep) &&
      basename(cleanupTarget).startsWith('yap-frontend-promo-smoke-'),
  );
  await rm(cleanupTarget, { recursive: true, force: true });
}
