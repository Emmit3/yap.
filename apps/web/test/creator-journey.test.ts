import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { createApp } from '../../api/src/app.js';
import { createCreatorResearch } from '../../api/src/creator-research.js';
import { createCreatorApi, CreatorApiError } from '../src/creator/api.js';
import { parseFilmCatalog, selectedFilm } from '../src/creator/references.js';
import { createPromoApi } from '../src/promo/api.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-creator-client-'));
  const errors: unknown[] = [];
  let paidCalls = 0;
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    workflowProviderConfig: { provider: 'guided' },
    creatorOptions: {
      analyze: createCreatorResearch(
        {},
        {
          fetch: async () => {
            throw new Error('No-key research must not contact a provider.');
          },
        },
      ),
      video: {
        configured: false,
        async generate() {
          paidCalls += 1;
          throw new Error('No paid provider is configured.');
        },
        async cancel() {},
      },
      auditor: {
        configured: false,
        async audit() {
          throw new Error('No visual auditor is configured.');
        },
      },
    },
    onError: (error) => errors.push(error),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    const target = resolve(directory);
    assert.ok(
      target.startsWith(resolve(tmpdir()) + sep) &&
        basename(target).startsWith('yap-creator-client-'),
    );
    await rm(target, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return {
    creator: createCreatorApi(origin),
    promo: createPromoApi(origin),
    directory,
    paidCalls: () => paidCalls,
  };
}

test('the studio client carries explicit intent and external references through review without claiming unavailable generation', async (t) => {
  const { creator, directory, paidCalls } = await fixture(t);
  const rawCatalog: unknown = JSON.parse(
    await readFile(new URL('../../../public/film-references.json', import.meta.url), 'utf8'),
  );
  assert.ok(
    rawCatalog &&
      typeof rawCatalog === 'object' &&
      'films' in rawCatalog &&
      Array.isArray(rawCatalog.films),
  );
  const films = parseFilmCatalog(rawCatalog);
  assert.equal(
    films.length,
    rawCatalog.films.length,
    'the studio can read every actual catalog record',
  );
  const film = films.find((item) => item.id === 'abc-hypervolt-plus');
  assert.ok(film, 'use the reviewed live Hypervolt reference, not the excluded OPKIX lead');
  assert.equal(film.watchUrl, 'https://www.youtube.com/watch?v=Ogz-efB0jR0');
  assert.ok(films.some((item) => item.id === 'bird-blend-magic-whisk'));
  assert.ok(films.some((item) => item.id === 'milia-matcha-tybann'));
  const externalReference = selectedFilm(film, film.techniques.slice(0, 1));
  let state = await creator.create({
    input: {
      mode: 'text',
      prompt: 'Create a weekend reel for our ceramic cups in Seattle.',
      location: 'Seattle',
      urls: [],
      duration: 15,
      platform: 'instagram',
      tone: 'conversational',
    },
    externalReferences: [externalReference],
  });
  const id = state.session.id;
  assert.equal(state.workflow.id, state.session.workflowId);
  assert.deepEqual(state.session.externalReferences, [externalReference]);
  assert.equal(state.session.approval, null);
  const started = await creator.analyze(id, state.session.version);
  let result = started;
  for (
    let count = 0;
    count < 100 && ['queued', 'running'].includes(result.job.status);
    count += 1
  ) {
    await delay(10);
    result = await creator.job(id, result.job.id);
  }
  assert.equal(result.job.status, 'succeeded', result.job.error?.message);
  state = await creator.get(id);
  assert.equal(state.session.research?.sources.length, 0);
  assert.equal(state.session.research?.references.length, 0);
  assert.ok(
    state.session.research?.coverage
      ?.filter((branch) => branch.branch !== 'context')
      .every((branch) => branch.status === 'unavailable'),
  );
  assert.ok(state.session.research?.questions.some((question) => question.id === 'audience'));
  const oldVersion = state.session.version;
  state = await creator.patch(id, {
    expectedVersion: oldVersion,
    answers: [
      { questionId: 'productName', answer: 'Mori Ceramics' },
      {
        questionId: 'productDescription',
        answer: 'Handmade ceramic cups made by our Seattle studio.',
      },
      { questionId: 'audience', answer: 'Neighbors who collect handmade ceramics' },
      { questionId: 'keyBenefits', answer: 'Handmade cups; Made in our Seattle studio' },
      { questionId: 'callToAction', answer: 'Visit our studio this weekend.' },
      {
        questionId: 'imageDirection',
        answer: 'Preserve the real shape and glaze of the supplied cups.',
      },
      { questionId: 'style', answer: 'Quiet, tactile macro photography.' },
    ],
  });
  await assert.rejects(
    creator.patch(id, { expectedVersion: oldVersion, answers: [] }),
    (error) => error instanceof CreatorApiError && error.status === 409,
  );
  state = await creator.prepare(id, {
    expectedVersion: state.session.version,
    expectedWorkflowVersion: state.workflow.version,
  });
  assert.equal(state.workflow.brief.productName, 'Mori Ceramics');
  assert.equal(state.workflow.brief.audience, 'Neighbors who collect handmade ceramics');
  assert.deepEqual(state.workflow.brief.keyBenefits, [
    'Handmade cups',
    'Made in our Seattle studio',
  ]);
  assert.ok(!JSON.stringify(state.workflow.brief).includes(externalReference.brand ?? 'Hyperice'));
  assert.ok(
    state.workflow.scenes?.scenes.some((scene) => scene.visual.includes(externalReference.url)),
  );
  assert.ok(state.session.plan);
  assert.equal(
    state.session.plan.clips.reduce((sum, clip) => sum + clip.seconds, 0),
    15,
  );
  assert.equal(state.session.plan.maxGeneratedSeconds, 30);
  assert.ok(
    state.session.plan.clips.some((clip) => clip.referenceIds?.includes(externalReference.id)),
  );
  assert.deepEqual(state.workflow.approvals, { brief: null, script: null, scenes: null });
  const planId = state.session.plan.id;
  state = await creator.approve(id, {
    expectedVersion: state.session.version,
    expectedWorkflowVersion: state.workflow.version,
    planId,
    reviewed: true,
  });
  assert.equal(state.session.approval?.planId, planId);
  assert.ok(Object.values(state.workflow.approvals).every(Boolean));
  assert.ok(state.session.approval);
  const approvedId = state.session.approval.id;
  const approvedVersion = state.session.version;
  const approvedWorkflowVersion = state.workflow.version;
  state = await creator.approve(id, {
    expectedVersion: approvedVersion,
    expectedWorkflowVersion: approvedWorkflowVersion,
    planId,
    reviewed: true,
  });
  assert.equal(
    state.session.approval?.id,
    approvedId,
    'reviewing the same plan cannot renew its paid attempt budget',
  );
  assert.equal(state.session.version, approvedVersion);
  assert.equal(state.workflow.version, approvedWorkflowVersion);
  assert.ok(state.session.approval);
  await assert.rejects(
    creator.produce(id, {
      expectedVersion: state.session.version,
      approvalId: state.session.approval.id,
      requestId: randomUUID(),
    }),
    (error) =>
      error instanceof CreatorApiError &&
      error.status === 503 &&
      error.code === 'CREATOR_PRODUCTION_NOT_CONFIGURED',
  );
  assert.equal(paidCalls(), 0);
  assert.equal((await creator.jobs(id)).jobs.filter((job) => job.kind === 'production').length, 0);
  state = await creator.patch(id, {
    expectedVersion: state.session.version,
    answers: [
      ...state.session.answers.filter((answer) => answer.questionId !== 'audience'),
      { questionId: 'audience', answer: 'Designers choosing a studio gift' },
    ],
  });
  assert.equal(state.session.approval, null);
  assert.equal(state.session.plan, null);
  assert.equal(
    (await creator.get(id)).session.answers.find((answer) => answer.questionId === 'audience')
      ?.answer,
    'Designers choosing a studio gift',
  );
  assert.ok(
    (await readFile(join(directory, 'creator-sessions.json'), 'utf8')).includes(
      externalReference.watchUrl,
    ),
  );
});

test('media-first creator and existing promo clients share one asset store and recover the same saved session', async (t) => {
  const { creator, promo } = await fixture(t);
  let state = await creator.create({
    input: { mode: 'media', prompt: 'A portrait product reel for our handmade cup.', urls: [] },
  });
  const photograph = await sharp({
    create: { width: 80, height: 120, channels: 3, background: '#d8d8d8' },
  })
    .jpeg()
    .toBuffer();
  const uploaded = await promo.upload(
    state.workflow.id,
    state.workflow.version,
    new File([new Uint8Array(photograph)], 'Our cup.jpg', { type: 'image/jpeg' }),
  );
  assert.equal(uploaded.workflow.assets.length, 1);
  state = await creator.get(state.session.id);
  assert.equal(state.workflow.assets[0]?.id, uploaded.workflow.assets[0]?.id);
  state = await creator.patch(state.session.id, {
    expectedVersion: state.session.version,
    answers: [
      { questionId: 'productName', answer: 'Mori cup' },
      { questionId: 'productDescription', answer: 'A handmade ceramic cup.' },
      { questionId: 'audience', answer: 'People who enjoy handmade objects' },
      { questionId: 'callToAction', answer: 'See the collection.' },
    ],
  });
  state = await creator.prepare(state.session.id, {
    expectedVersion: state.session.version,
    expectedWorkflowVersion: state.workflow.version,
  });
  assert.ok(
    state.session.plan?.clips.some((clip) => clip.assetId === uploaded.workflow.assets[0]?.id),
  );
  const reloaded = await creator.get(state.session.id);
  assert.equal(reloaded.session.id, state.session.id);
  assert.equal(reloaded.workflow.version, state.workflow.version);
  assert.deepEqual(reloaded.workflow.assets, uploaded.workflow.assets);
  assert.equal((await promo.get(state.workflow.id)).workflow.id, state.workflow.id);
  await assert.rejects(
    creator.patch(state.session.id, {
      expectedVersion: state.session.version,
      selectedReferenceIds: ['not-from-this-research'],
    }),
    (error) => error instanceof CreatorApiError && error.status === 400,
  );
});
