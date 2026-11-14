import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import sharp from 'sharp';
import { z } from 'zod';
import {
  creatorBudgetResponseSchema,
  creatorJobResponseSchema,
  creatorJobSchema,
  creatorQuoteResponseSchema,
  creatorQuoteSchema,
  creatorSessionResponseSchema,
  type CreatorJob,
  type CreatorQuote,
} from '@yap/contracts/creator';
import { workflowResponseSchema } from '@yap/contracts/workflow';
import { createApp } from '../src/app.js';
import { creatorBudgetStateSchema, type CreatorBudgetLedger } from '../src/creator-budget.js';

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const persistedSchema = z.object({
  jobs: z.array(creatorJobSchema),
  quotes: z.array(creatorQuoteSchema),
  budget: creatorBudgetStateSchema,
});

test(
  'default fal production crosses real HTTP approval, durable budget, vision audit and MP4 assembly',
  { timeout: 60_000 },
  async (t) => {
    // Node's test runner isolates this file in its own process. Use dummy credentials
    // without inspecting inherited credentials, and deny all unexpected provider URLs.
    Object.assign(process.env, {
      FAL_KEY: 'fal-integration-fixture',
      OPENAI_API_KEY: 'vision-integration-fixture',
      OPENAI_MODEL: 'gpt-6-luna',
      CREATOR_BUDGET_LIMIT_USD: '30.00',
      FIRECRAWL_API_KEY: '',
      DEEPAGENTS_MODEL: '',
      DEEPAGENTS_OPENAI_API_KEY: '',
      RUNWAYML_API_SECRET: '',
    });
    delete process.env.CREATOR_VIDEO_PROVIDER;
    const directory = await mkdtemp(join(tmpdir(), 'yap-fal-integrated-'));
    let closeApp: (() => Promise<void>) | undefined;
    t.after(async () => {
      await closeApp?.();
      await rm(directory, { recursive: true, force: true });
    });
    const dataFile = join(directory, 'creator-sessions.json'),
      videoPath = join(directory, 'provider-fixture.mp4');
    const binary: unknown = createRequire(import.meta.url)('ffmpeg-static');
    assert.equal(typeof binary, 'string');
    const encoder = spawn(
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
        videoPath,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    assert.equal((await once(encoder, 'close'))[0], 0);
    const video = await readFile(videoPath);
    const stored = async () => persistedSchema.parse(JSON.parse(await readFile(dataFile, 'utf8')));
    const tasks = new Map<string, { polls: number; downloaded: boolean }>();
    const calls: Array<{ url: string; method: string }> = [];
    let quote: CreatorQuote | undefined,
      ledger: CreatorBudgetLedger | undefined,
      audits = 0,
      imageSubmits = 0,
      textSubmits = 0;
    const transport: typeof fetch = async (input, init) => {
      const url = String(input),
        method = init?.method ?? 'GET';
      calls.push({ url, method });
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      if (method === 'POST' && url.startsWith('https://queue.fal.run/')) {
        assert.ok(quote && ledger);
        assert.ok(
          [
            'https://queue.fal.run/fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
            'https://queue.fal.run/fal-ai/bytedance/seedance/v1.5/pro/text-to-video',
          ].includes(url),
          'only the selected Seedance model is submitted',
        );
        assert.equal(headers.get('authorization'), 'Key fal-integration-fixture');
        const body = z
          .object({
            prompt: z.string().min(1).max(1000),
            aspect_ratio: z.literal('9:16'),
            resolution: z.literal('720p'),
            duration: z.literal('5'),
            generate_audio: z.literal(false),
            enable_safety_checker: z.literal(true),
            image_url: z.string().optional(),
          })
          .strict()
          .parse(JSON.parse(String(init?.body)));
        if (url.endsWith('/image-to-video')) {
          imageSubmits++;
          assert.match(body.image_url ?? '', /^data:image\/jpeg;base64,/);
          const metadata = await sharp(
            Buffer.from(body.image_url!.split(',')[1]!, 'base64'),
          ).metadata();
          assert.equal(metadata.width, 720);
          assert.equal(metadata.height, 1280);
        } else {
          textSubmits++;
          assert.equal(body.image_url, undefined);
        }
        const state = await stored(),
          consumed = state.quotes.find((item) => item.id === quote!.id);
        const job = state.jobs.find((item) => item.quoteId === quote!.id);
        assert.ok(job && consumed?.approvedApprovalId);
        assert.equal(
          consumed.consumedByJobId,
          job.id,
          'quote consumption is durable before provider POST',
        );
        assert.equal(job.reservationIds?.length, quote.clips.length);
        assert.equal(state.budget.reservations.length, quote.clips.length);
        assert.equal(
          (await ledger.budget()).reservedCents,
          quote.maxCostCents,
          'the entire approved ceiling is held before the first clip starts',
        );
        for (const item of quote.clips) {
          const hold = state.budget.reservations.find(
            (value) => value.sourceId === `${job.id}:${item.clipId}`,
          );
          assert.equal(hold?.amountCents, item.costCents);
          assert.equal(hold?.chargedCents, null);
        }
        assert.ok(
          job.clips.some(
            (item) =>
              item.status === 'generating' && item.reservationId && item.providerTaskId === null,
          ),
        );
        const id = randomUUID();
        tasks.set(id, { polls: 0, downloaded: false });
        const root = `https://queue.fal.run/fal-ai/bytedance/requests/${id}`;
        return Response.json({
          request_id: id,
          response_url: root,
          status_url: `${root}/status`,
          cancel_url: `${root}/cancel`,
          queue_position: 0,
        });
      }
      const operation =
        /^https:\/\/queue\.fal\.run\/fal-ai\/bytedance\/requests\/([a-f0-9-]+)(\/status)?$/.exec(
          url,
        );
      if (operation && method === 'GET') {
        assert.equal(headers.get('authorization'), 'Key fal-integration-fixture');
        const id = operation[1]!,
          task = tasks.get(id);
        assert.ok(task);
        const job = (await stored()).jobs.find((item) => item.quoteId === quote?.id);
        assert.ok(
          job?.clips.some((item) => item.providerTaskId === `fal:seedance-1.5:${id}`),
          'provider ID is durable before polling',
        );
        if (operation[2])
          return Response.json({ status: ++task.polls === 1 ? 'IN_QUEUE' : 'COMPLETED' });
        assert.equal(task.polls, 2);
        return Response.json({
          video: { url: `https://v3b.fal.media/files/creator-integration/${id}.mp4` },
          seed: 42,
        });
      }
      const download =
        /^https:\/\/v3b\.fal\.media\/files\/creator-integration\/([a-f0-9-]+)\.mp4$/.exec(url);
      if (download && method === 'GET') {
        assert.equal(
          headers.get('authorization'),
          null,
          'provider credentials never reach the artifact CDN',
        );
        const task = tasks.get(download[1]!);
        assert.ok(task && !task.downloaded);
        task.downloaded = true;
        return new Response(video, {
          headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) },
        });
      }
      if (url === 'https://api.openai.com/v1/responses' && method === 'POST') {
        audits++;
        assert.equal(headers.get('authorization'), 'Bearer vision-integration-fixture');
        const body = z
          .object({
            model: z.literal('gpt-6-luna'),
            max_output_tokens: z.literal(2048),
            service_tier: z.literal('default'),
            store: z.literal(false),
            reasoning: z.object({ effort: z.literal('none') }),
            text: z.object({
              format: z
                .object({ type: z.literal('json_schema'), strict: z.literal(true) })
                .passthrough(),
            }),
            input: z.array(
              z.object({
                content: z.array(
                  z.object({ type: z.string(), image_url: z.string().optional() }).passthrough(),
                ),
              }),
            ),
          })
          .passthrough()
          .parse(JSON.parse(String(init?.body)));
        const images = body.input
          .flatMap((item) => item.content)
          .filter((item) => item.type === 'input_image');
        assert.equal(
          images.length,
          audits <= 2 ? 4 : 3,
          'actual auditor receives the creator reference and three decoded frames',
        );
        for (const image of images) {
          const metadata = await sharp(
            Buffer.from(image.image_url!.split(',')[1]!, 'base64'),
          ).metadata();
          assert.ok(metadata.width! <= 640 && metadata.height! <= 640);
        }
        assert.ok(quote && ledger);
        assert.equal(
          (await ledger.budget()).reservedCents,
          quote.maxCostCents,
          'the prepaid audit does not create a second unquoted hold',
        );
        assert.equal((await stored()).budget.reservations.length, quote.clips.length);
        return Response.json({
          status: 'completed',
          usage: { input_tokens: 1000, output_tokens: 200 },
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    passed: true,
                    summary: 'Mocked model reviewed only the supplied sampled frames.',
                    issues: [],
                  }),
                },
              ],
            },
          ],
        });
      }
      assert.fail(`Unexpected external HTTP request: ${method} ${url}`);
    };
    const app = await createApp({
      dataFile: join(directory, 'projects.json'),
      creatorDataFile: dataFile,
      workflowProviderConfig: { provider: 'guided' },
      workflowFetch: transport,
      socialFetch: transport,
      creatorOptions: {
        fetch: transport,
        videoConfig: { pollMs: 1, timeoutMs: 15_000 },
        withBudget(value) {
          ledger = value;
          return {};
        },
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api`;
    closeApp = async () => {
      await app.locals.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    };
    async function typed<T>(
      path: string,
      schema: z.ZodType<T>,
      init?: RequestInit,
      status = 200,
    ): Promise<T> {
      const response = await fetch(base + path, init);
      assert.equal(response.status, status, await response.clone().text());
      return schema.parse(await response.json());
    }
    const capabilities = await typed(
      '/creator/capabilities',
      z.object({
        configured: z.literal(true),
        visionConfigured: z.literal(true),
        provider: z.literal('fal'),
        model: z.literal('seedance-v1.5-pro'),
        hasAudio: z.literal(false),
      }),
    );
    assert.equal(
      capabilities.provider,
      'fal',
      'the default provider is selected without injecting a video implementation',
    );
    let value = await typed(
      '/creator/sessions',
      creatorSessionResponseSchema,
      json({
        input: {
          mode: 'media',
          prompt: 'A ceramic cup product film in soft studio light.',
          urls: [],
          duration: 15,
        },
      }),
      201,
    );
    const prefix = `/creator/sessions/${value.session.id}`;
    const photo = await sharp({
      create: { width: 640, height: 360, channels: 3, background: '#688567' },
    })
      .png()
      .toBuffer();
    await typed(
      `/workflows/${value.workflow.id}/assets?expectedVersion=${value.workflow.version}`,
      workflowResponseSchema,
      {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'X-Filename': 'creator-cup.png' },
        body: photo,
      },
      201,
    );
    value = await typed(prefix, creatorSessionResponseSchema);
    assert.equal(value.workflow.assets.length, 1);
    value = await typed(
      prefix + '/prepare',
      creatorSessionResponseSchema,
      json({
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
      }),
    );
    assert.equal(value.session.plan?.provider, 'fal');
    assert.equal(value.session.plan?.model, 'seedance-v1.5-pro');
    assert.equal(value.session.plan?.clips.length, 3);
    assert.ok(value.session.plan?.clips.every((item) => item.seconds === 5 && item.assetId));
    // Review one original text-only shot alongside two shots anchored in the uploaded photo.
    const clips = value.session.plan!.clips.map((item, index) => {
      if (index !== 2) return item;
      const { assetId: _assetId, ...textClip } = item;
      return {
        ...textClip,
        prompt: 'An original ceramic cup hero composition against a neutral studio background.',
      };
    });
    value = await typed(
      prefix + '/plan',
      creatorSessionResponseSchema,
      json(
        {
          expectedVersion: value.session.version,
          expectedWorkflowVersion: value.workflow.version,
          caption: value.session.plan!.caption,
          clips,
        },
        'PATCH',
      ),
    );
    const quoted = await typed(
      prefix + '/quote',
      creatorQuoteResponseSchema,
      json({
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
      }),
    );
    quote = quoted.quote;
    assert.equal(quote.maxCostCents, 105);
    assert.equal(quoted.budget.reservedCents, 0, 'quoting alone starts no paid work');
    assert.equal(calls.length, 0);
    value = await typed(
      prefix + '/approve',
      creatorSessionResponseSchema,
      json({
        expectedVersion: value.session.version,
        expectedWorkflowVersion: value.workflow.version,
        planId: value.session.plan!.id,
        quoteId: quote.id,
        reviewed: true,
        costReviewed: true,
      }),
    );
    assert.equal(calls.length, 0, 'approval alone does not dispatch providers');
    const requestBody = {
      expectedVersion: value.session.version,
      approvalId: value.session.approval!.id,
      quoteId: quote.id,
      requestId: randomUUID(),
    };
    const started = await typed(
      prefix + '/produce',
      creatorJobResponseSchema,
      json(requestBody),
      202,
    );
    let completed: CreatorJob | undefined;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = await typed(prefix + `/jobs/${started.job.id}`, creatorJobResponseSchema);
      if (['succeeded', 'failed', 'canceled'].includes(current.job.status)) {
        completed = current.job;
        break;
      }
      await delay(20);
    }
    assert.ok(completed, 'the production job reaches a terminal state');
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
    assert.equal(completed.clips.length, 3);
    assert.ok(
      completed.clips.every(
        (item) =>
          item.attempt === 1 &&
          item.status === 'passed' &&
          item.audit?.technicalPassed &&
          item.audit.visionPassed,
      ),
    );
    assert.equal(tasks.size, 3);
    assert.equal(imageSubmits, 2);
    assert.equal(textSubmits, 1);
    assert.equal(audits, 3);
    assert.ok([...tasks.values()].every((item) => item.polls === 2 && item.downloaded));
    const response = await fetch(base + prefix + `/jobs/${completed.id}/video?download=1`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^video\/mp4/);
    assert.match(
      response.headers.get('content-disposition') ?? '',
      /attachment.*yap-creation\.mp4/,
    );
    const final = Buffer.from(await response.arrayBuffer());
    assert.equal(final.toString('ascii', 4, 8), 'ftyp');
    assert.equal(createHash('sha256').update(final).digest('hex'), completed.output?.sha256);
    assert.equal(final.length, completed.output?.bytes);
    assert.equal(completed.output?.duration, 15);
    assert.equal(completed.output?.hasAudio, false);
    const latest = await typed(prefix, creatorSessionResponseSchema);
    assert.ok(latest.session.plan!.caption.trim());
    assert.equal(
      latest.session.plan!.caption,
      latest.workflow.script!.caption,
      'the publish caption is the current approved caption',
    );
    const budget = await typed('/creator/budget', creatorBudgetResponseSchema);
    assert.equal(budget.budget.limitCents, 3000);
    assert.equal(budget.budget.reservedCents, quote.maxCostCents);
    assert.ok(budget.budget.reservedCents + budget.budget.chargedCents <= 3000);
    const paidCount = calls.filter((item) => item.method === 'POST').length;
    const duplicate = await typed(
      prefix + '/produce',
      creatorJobResponseSchema,
      json(requestBody),
      202,
    );
    assert.equal(duplicate.job.id, completed.id);
    const replay = await fetch(
      base + prefix + '/produce',
      json({ ...requestBody, requestId: randomUUID() }),
    );
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, 'CREATOR_QUOTE_CONSUMED');
    assert.equal(
      calls.filter((item) => item.method === 'POST').length,
      paidCount,
      'no duplicate or second paid retry was dispatched',
    );
    await typed(
      prefix,
      creatorSessionResponseSchema,
      json(
        {
          expectedVersion: latest.session.version,
          answers: [{ questionId: 'audience', answer: 'A changed audience needs new approval.' }],
        },
        'PATCH',
      ),
    );
    assert.equal(
      (await fetch(base + prefix + `/jobs/${completed.id}/video`)).status,
      409,
      'an edited source cannot download the previous artifact as current',
    );
  },
);
