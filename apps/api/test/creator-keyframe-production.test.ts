import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import {
  creatorSessionResponseSchema,
  creatorJobResponseSchema,
  creatorQuoteResponseSchema,
} from '@yap/contracts/creator';
import {
  creatorImageQuoteResponseSchema,
  creatorImageJobResponseSchema,
} from '@yap/contracts/creator-images';
import { createApp } from '../src/app.js';

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a generated frame stays a candidate until selected, then reaches animation and audit through the approved quote', async (t) => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'yap-keyframe-film-'));
  const encoder: unknown = createRequire(import.meta.url)('ffmpeg-static');
  assert.ok(typeof encoder === 'string');
  const providerVideo = join(directory, 'provider.mp4');
  await promisify(execFile)(
    encoder,
    [
      '-hide_banner',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:s=720x1280:r=24:d=5',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-y',
      providerVideo,
    ],
    { windowsHide: true },
  );
  const footage = await readFile(providerVideo);
  const frame = await sharp({
    create: { width: 864, height: 1536, channels: 3, background: '#607066' },
  })
    .png()
    .toBuffer();
  let imageCalls = 0,
    videoCalls = 0,
    auditCalls = 0;
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    creatorOptions: {
      imageProvider: {
        configured: true,
        generate: async (request) => {
          imageCalls++;
          await request.beforeSubmit();
          return {
            bytes: frame,
            mimeType: 'image/png',
            usage: { textInputTokens: 10, imageInputTokens: 0, outputTokens: 1000 },
          };
        },
      },
      video: {
        configured: true,
        profile: {
          provider: 'fal',
          model: 'minimax-h3-max',
          minSeconds: 2,
          maxSeconds: 10,
          rateCentsPerSecond: 10,
          priceSourceUrl: 'https://fal.ai/models/minimax/h3-max/image-to-video',
          pricingCheckedAt: '2026-11-14',
        },
        cancel: async () => {},
        generate: async (request) => {
          videoCalls++;
          assert.deepEqual(request.image, frame);
          assert.ok(request.clip.keyframeId);
          await request.beforeSubmit?.();
          await request.onSubmitted(`fixture:${randomUUID()}`);
          return footage;
        },
      },
      auditor: {
        configured: true,
        audit: async (_clip, frames, reference, _signal, beforeSubmit) => {
          auditCalls++;
          assert.equal(frames.length, 3);
          assert.deepEqual(reference, frame);
          await beforeSubmit?.();
          return {
            technicalPassed: true,
            visionPassed: true,
            summary: 'Injected sampled review passed.',
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
  const request = (path: string, init?: RequestInit) => fetch(base + path, init);
  t.after(async () => {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>((res, rej) => server.close((error) => (error ? rej(error) : res())));
    assert.ok(resolve(directory).startsWith(parent + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const envelope = async (response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return creatorSessionResponseSchema.parse(await response.json());
  };
  const created = await request(
    '/sessions',
    json('POST', {
      input: {
        mode: 'text',
        prompt: 'A creator studio comes alive at an office desk.',
        duration: 15,
        platform: 'instagram',
        tone: 'bold',
        urls: [],
      },
    }),
  );
  assert.equal(created.status, 201);
  let current = creatorSessionResponseSchema.parse(await created.json());
  const path = `/sessions/${current.session.id}`;
  current = await envelope(
    await request(
      path,
      json('PATCH', {
        expectedVersion: current.session.version,
        answers: [
          { questionId: 'productName', answer: 'Yap Studio' },
          { questionId: 'audience', answer: 'Independent filmmakers' },
          { questionId: 'callToAction', answer: 'Create a new film' },
        ],
      }),
    ),
  );
  current = await envelope(
    await request(
      path + '/prepare',
      json('POST', {
        expectedVersion: current.session.version,
        expectedWorkflowVersion: current.workflow.version,
      }),
    ),
  );
  const originalPlan = current.session.plan!;
  const originalVersion = current.session.version;
  const quoted = await request(
    path + '/images/quote',
    json('POST', {
      expectedVersion: current.session.version,
      expectedWorkflowVersion: current.workflow.version,
      settings: {
        prompt: 'A warmly lit original creative studio desk, portrait composition.',
        model: 'gpt-image-2.6-flare',
        quality: 'medium',
        size: '864x1536',
        complexity: 'low',
        clipId: originalPlan.clips[0]!.id,
      },
    }),
  );
  assert.equal(quoted.status, 200, await quoted.clone().text());
  const { quote: imageQuote } = creatorImageQuoteResponseSchema.parse(await quoted.json());
  const imageRequest = {
    expectedVersion: current.session.version,
    expectedWorkflowVersion: current.workflow.version,
    quoteId: imageQuote.id,
    requestId: randomUUID(),
    costReviewed: true,
  };
  const started = await request(path + '/images/jobs', json('POST', imageRequest));
  assert.equal(started.status, 202, await started.clone().text());
  let imageJob = creatorImageJobResponseSchema.parse(await started.json()).job;
  for (let n = 0; n < 200 && ['queued', 'running'].includes(imageJob.status); n++) {
    await delay(30);
    imageJob = creatorImageJobResponseSchema.parse(
      await (await request(path + `/images/jobs/${imageJob.id}`)).json(),
    ).job;
  }
  assert.equal(imageJob.status, 'succeeded', JSON.stringify(imageJob.error));
  assert.ok(imageJob.variantId);
  const unchanged = await envelope(await request(path));
  assert.equal(unchanged.session.version, originalVersion);
  assert.equal(unchanged.session.plan!.id, originalPlan.id);
  assert.equal(
    unchanged.workflow.assets.length,
    0,
    'generated frames must not become uploaded creator photos',
  );
  const repeated = await request(path + '/images/jobs', json('POST', imageRequest));
  assert.ok([200, 202].includes(repeated.status));
  assert.equal(creatorImageJobResponseSchema.parse(await repeated.json()).job.id, imageJob.id);
  assert.equal(imageCalls, 1);
  for (const clip of originalPlan.clips) {
    current = await envelope(
      await request(
        path + '/keyframe',
        json('POST', {
          expectedVersion: current.session.version,
          expectedWorkflowVersion: current.workflow.version,
          planId: current.session.plan!.id,
          clipId: clip.id,
          variantId: imageJob.variantId,
        }),
      ),
    );
  }
  assert.equal(current.session.approval, null);
  assert.equal(current.workflow.assets.length, 0);
  const tampered = current.session.plan!.clips.map((clip, index) =>
    index === 0 ? { ...clip, keyframeSha256: 'b'.repeat(64) } : clip,
  );
  const bad = await request(
    path + '/plan',
    json('PATCH', {
      expectedVersion: current.session.version,
      expectedWorkflowVersion: current.workflow.version,
      caption: current.session.plan!.caption,
      clips: tampered,
    }),
  );
  assert.equal(
    bad.status,
    409,
    'a supplied generated-image hash must match stored ownership and bytes',
  );
  const videoQuoteResponse = await request(
    path + '/quote',
    json('POST', {
      expectedVersion: current.session.version,
      expectedWorkflowVersion: current.workflow.version,
    }),
  );
  assert.equal(videoQuoteResponse.status, 200, await videoQuoteResponse.clone().text());
  const { quote } = creatorQuoteResponseSchema.parse(await videoQuoteResponse.json());
  current = await envelope(
    await request(
      path + '/approve',
      json('POST', {
        expectedVersion: current.session.version,
        expectedWorkflowVersion: current.workflow.version,
        planId: current.session.plan!.id,
        quoteId: quote.id,
        reviewed: true,
        costReviewed: true,
      }),
    ),
  );
  const production = await request(
    path + '/produce',
    json('POST', {
      expectedVersion: current.session.version,
      approvalId: current.session.approval!.id,
      quoteId: quote.id,
      requestId: randomUUID(),
    }),
  );
  assert.equal(production.status, 202, await production.clone().text());
  let job = creatorJobResponseSchema.parse(await production.json()).job;
  for (let n = 0; n < 500 && ['queued', 'running'].includes(job.status); n++) {
    await delay(50);
    job = creatorJobResponseSchema.parse(
      await (await request(path + `/jobs/${job.id}`)).json(),
    ).job;
  }
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(videoCalls, originalPlan.clips.length);
  assert.equal(auditCalls, originalPlan.clips.length);
  assert.equal(job.output?.hasAudio, false);
  assert.equal(job.output?.width, 1080);
  assert.equal(job.output?.height, 1920);
  const clipResponse = await request(
    path + `/jobs/${job.id}/clips/${job.clips[0]!.clipId}/video?attempt=1`,
  );
  assert.equal(clipResponse.status, 200);
  assert.notDeepEqual(
    Buffer.from(await clipResponse.arrayBuffer()),
    footage,
    'served clip must be the silent normalized file with its own receipt',
  );
});
