import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import sharp from 'sharp';
import {
  creatorJobResponseSchema,
  creatorQuoteResponseSchema,
  creatorSessionResponseSchema,
  type CreatorClip,
} from '@yap/contracts/creator';
import { createApp } from '../src/app.js';
import { createCreatorVisionAuditor } from '../src/creator-media.js';
import { ApiError } from '../src/errors.js';

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A ceramic cup.',
  camera: 'Slow push in.',
  lighting: 'Soft side light.',
};
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function auditResponse() {
  return Response.json({
    status: 'completed',
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              passed: true,
              summary: 'Only sampled frames reviewed.',
              issues: [],
            }),
          },
        ],
      },
    ],
  });
}

test('vision checks final approval after image preparation and before a paid request', async (t) => {
  const frame = await sharp({
    create: { width: 360, height: 640, channels: 3, background: '#555' },
  })
    .jpeg()
    .toBuffer();
  await t.test('rejected approval cannot dispatch the model', async () => {
    let requests = 0,
      checks = 0;
    const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () => {
      requests++;
      return auditResponse();
    });
    await assert.rejects(
      auditor.audit(clip, [frame, frame, frame], frame, new AbortController().signal, async () => {
        checks++;
        throw new ApiError(409, 'CREATOR_SOURCE_CHANGED', 'The approved plan changed.');
      }),
      { code: 'CREATOR_SOURCE_CHANGED' },
    );
    assert.equal(checks, 1);
    assert.equal(requests, 0);
  });
  await t.test('pending approval check blocks the model until released', async () => {
    const entered = latch(),
      gate = latch();
    let requests = 0;
    const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () => {
      requests++;
      return auditResponse();
    });
    const done = auditor.audit(
      clip,
      [frame, frame, frame],
      undefined,
      new AbortController().signal,
      async () => {
        entered.release();
        await gate.promise;
      },
    );
    await entered.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 0);
    gate.release();
    assert.equal((await done).visionPassed, true);
    assert.equal(requests, 1);
  });
  await t.test('cancellation while final check is pending prevents the model request', async () => {
    const entered = latch(),
      gate = latch(),
      controller = new AbortController();
    let requests = 0;
    const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async () => {
      requests++;
      return auditResponse();
    });
    const done = auditor.audit(
      clip,
      [frame, frame, frame],
      undefined,
      controller.signal,
      async () => {
        entered.release();
        await gate.promise;
      },
    );
    await entered.promise;
    controller.abort();
    gate.release();
    await assert.rejects(done, { code: 'CREATOR_CANCELED' });
    assert.equal(requests, 0);
  });
});

test(
  'a plan edited during audit preparation cannot start paid vision or another clip',
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'yap-audit-submit-'));
    const path = join(directory, 'fixture.mp4');
    const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
    assert.equal(typeof binary, 'string');
    const child = spawn(
      binary as string,
      [
        '-hide_banner',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=360x640:rate=24',
        '-t',
        '5',
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
      { windowsHide: true, stdio: 'ignore' },
    );
    assert.equal((await once(child, 'close'))[0], 0);
    const bytes = await readFile(path),
      preparing = latch(),
      gate = latch();
    let paidVideo = 0,
      paidVision = 0;
    const app = await createApp({
      dataFile: join(directory, 'projects.json'),
      workflowProviderConfig: { provider: 'guided' },
      creatorOptions: {
        analyze: async () => ({
          summary: 'No live source calls.',
          productFacts: [],
          cinematography: '',
          sources: [],
          references: [],
          questions: [],
          limitations: [],
        }),
        video: {
          configured: true,
          cancel: async () => {},
          generate: async ({ beforeSubmit, onSubmitted }) => {
            await beforeSubmit?.();
            paidVideo++;
            await onSubmitted(randomUUID());
            return bytes;
          },
        },
        auditor: {
          configured: true,
          audit: async (_clip, frames, _image, signal, beforeSubmit) => {
            assert.equal(frames.length, 3, 'real decoded frames reached audit preparation');
            assert.equal(
              typeof beforeSubmit,
              'function',
              'the worker supplies the current-approval check',
            );
            preparing.release();
            await gate.promise;
            await beforeSubmit?.();
            signal.throwIfAborted();
            paidVision++;
            return {
              technicalPassed: true,
              visionPassed: true,
              summary: 'Sampled frames reviewed.',
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
      gate.release();
      await app.locals.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    });
    const send = async (route: string, body: unknown, method = 'POST') => {
      const response = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    let value = creatorSessionResponseSchema.parse(
      await send('/sessions', {
        input: { mode: 'text', prompt: 'Ceramic cups in soft studio light', urls: [] },
      }),
    );
    const prefix = `/sessions/${value.session.id}`;
    value = creatorSessionResponseSchema.parse(
      await send(prefix + '/prepare', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
      }),
    );
    const { quote } = creatorQuoteResponseSchema.parse(
      await send(prefix + '/quote', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
      }),
    );
    value = creatorSessionResponseSchema.parse(
      await send(prefix + '/approve', {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        planId: value.session.plan!.id,
        reviewed: true,
        costReviewed: true,
        quoteId: quote.id,
      }),
    );
    const { job } = creatorJobResponseSchema.parse(
      await send(prefix + '/produce', {
        expectedVersion: value.session.version,
        approvalId: value.session.approval!.id,
        quoteId: quote.id,
        requestId: randomUUID(),
      }),
    );
    await preparing.promise;
    await send(
      prefix + '/plan',
      {
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        caption: value.session.plan!.caption,
        clips: value.session.plan!.clips.map((item, index) =>
          index ? item : { ...item, prompt: 'Changed composition, now requiring a new approval.' },
        ),
      },
      'PATCH',
    );
    gate.release();
    let terminal;
    for (let attempt = 0; attempt < 300; attempt++) {
      const response = await fetch(base + prefix + `/jobs/${job.id}`);
      const current = creatorJobResponseSchema.parse(await response.json()).job;
      if (['succeeded', 'failed', 'canceled'].includes(current.status)) {
        terminal = current;
        break;
      }
      await delay(20);
    }
    assert.equal(terminal?.status, 'failed');
    assert.equal(terminal?.error?.code, 'CREATOR_SOURCE_CHANGED');
    assert.equal(paidVision, 0, 'the stale plan is rejected before the paid model dispatch');
    assert.equal(paidVideo, 1, 'no later clip can be generated after the edit');
  },
);
