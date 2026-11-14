import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectResponseSchema } from '@yap/contracts';
import { workflowResponseSchema } from '@yap/contracts/workflow';
import { socialHandoffSchema, socialInvestigationResponseSchema } from '@yap/contracts/social';
import { createApp } from '../src/app.js';
import { createWorkflowProvider, type VideoWorkflowProvider } from '../src/workflow-provider.js';

test('saved research decisions guide projects and promo workflows without becoming creator facts or approvals', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yap-social-integration-'));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: Server | undefined;
  let base = '';
  async function start() {
    app = await createApp({
      dataFile: join(directory, 'projects.json'),
      socialProviderConfig: {},
      workflowProviderConfig: { provider: 'guided' },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}/api`;
  }
  async function stop() {
    await app?.locals.shutdown?.();
    const active = server;
    if (active?.listening)
      await new Promise<void>((resolve, reject) =>
        active.close((error) => (error ? reject(error) : resolve())),
      );
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  const send = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const created = await send('/social/investigations', {
    topic: 'Coffee education',
    mode: 'demo',
    platforms: ['x'],
    limit: 20,
  });
  assert.equal(created.status, 201);
  const { investigation } = socialInvestigationResponseSchema.parse(await created.json());
  const evidenceId = investigation.analysis.posts[0]!.id;
  const saved = await send(`/social/investigations/${investigation.id}/notes`, {
    text: 'Open with one clear question and answer it using our own verified information.',
    kind: 'adopt',
    evidenceIds: [evidenceId],
  });
  assert.equal(saved.status, 201);
  const withNote = socialInvestigationResponseSchema.parse(await saved.json()).investigation;
  const handoffResponse = await send(`/social/investigations/${investigation.id}/handoff`, {
    noteIds: [withNote.notes[0]!.id],
    insightIds: [],
  });
  assert.equal(handoffResponse.status, 200);
  const handoff = socialHandoffSchema.parse(await handoffResponse.json());
  assert.equal(handoff.sourceUrls.length, 1);
  const projectResponse = await send('/projects', {
    title: 'Our reusable filter',
    idea: 'Show our reusable coffee filter and explain how to rinse it after use.',
    audience: 'People making coffee at home',
    research: handoff,
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
  const changed = await send(
    `/projects/${project.id}`,
    {
      research: { ...handoff, creativeDirection: 'Adopt: Show a demonstration first.' },
    },
    'PATCH',
  );
  assert.equal(changed.status, 200);
  const changedProject = projectResponseSchema.parse(await changed.json()).project;
  assert.equal(changedProject.draft, null);

  const creatorInput =
    'Make a short promo about our reusable coffee filter using our own product details.';
  const creatorBrief = {
    productName: 'Our reusable filter',
    productDescription: 'A reusable coffee filter that rinses under running water.',
    audience: 'People making coffee at home',
    keyBenefits: ['Rinses under running water after each brew.'],
    callToAction: 'See the filter in our shop.',
    imageDirection: 'Show our actual filter and the rinse process.',
    platform: 'instagram',
    duration: 30,
    tone: 'educational',
  };
  const workflowCreated = await send('/workflows', {
    title: 'Reusable filter promo',
    input: creatorInput,
    brief: creatorBrief,
    research: handoff,
  });
  assert.equal(workflowCreated.status, 201, await workflowCreated.clone().text());
  const { workflow } = workflowResponseSchema.parse(await workflowCreated.json());
  assert.deepEqual(workflow.research, handoff);
  assert.deepEqual(workflow.brief, creatorBrief);
  assert.equal(workflow.input, creatorInput);
  assert.deepEqual(workflow.approvals, { brief: null, script: null, scenes: null });
  assert.equal(workflow.script, null);
  assert.equal(workflow.scenes, null);

  const preparedResponse = await send(`/workflows/${workflow.id}/prepare`, {
    expectedVersion: workflow.version,
  });
  assert.equal(preparedResponse.status, 200, await preparedResponse.clone().text());
  const prepared = workflowResponseSchema.parse(await preparedResponse.json());
  assert.deepEqual(prepared.workflow.research, handoff);
  assert.deepEqual(prepared.workflow.brief, creatorBrief);
  assert.equal(prepared.workflow.input, creatorInput);
  assert.match(prepared.workflow.script!.hook, /^What should you know/);
  assert.match(prepared.workflow.scenes!.scenes[0]!.visual, /viewer question/);
  assert.equal(prepared.workflow.script!.caption.split('\n')[0], creatorBrief.productDescription);
  assert.ok(
    prepared.workflow.script!.segments.some(
      (segment) => segment.text === creatorBrief.keyBenefits[0],
    ),
  );
  assert.ok(!JSON.stringify(prepared.workflow.brief).includes(handoff.evidence[0]!.excerpt));
  assert.ok(!JSON.stringify(prepared.workflow.script).includes(handoff.evidence[0]!.excerpt));
  assert.deepEqual(prepared.workflow.approvals, { brief: null, script: null, scenes: null });
  assert.ok(Object.values(prepared.verification).every((stage) => stage.state !== 'approved'));

  await stop();
  await start();
  const persistedPrepared = workflowResponseSchema.parse(
    await (await fetch(`${base}/workflows/${workflow.id}`)).json(),
  );
  assert.deepEqual(persistedPrepared.workflow, prepared.workflow);
  assert.deepEqual(persistedPrepared.workflow.approvals, {
    brief: null,
    script: null,
    scenes: null,
  });
  const approvedResponse = await send(`/workflows/${workflow.id}/approve-all`, {
    expectedVersion: prepared.workflow.version,
  });
  assert.equal(approvedResponse.status, 200, await approvedResponse.clone().text());
  const { workflow: approved } = workflowResponseSchema.parse(await approvedResponse.json());
  assert.equal(approved.approvals.brief, approved.contentRevision);
  assert.equal(approved.approvals.script, approved.script!.id);
  assert.equal(approved.approvals.scenes, approved.scenes!.id);

  const changedNote = await send(
    `/social/investigations/${investigation.id}/notes/${withNote.notes[0]!.id}`,
    {
      text: 'Start with a visual demonstration using our own verified material.',
    },
    'PATCH',
  );
  assert.equal(changedNote.status, 200);
  const updatedHandoffResponse = await send(`/social/investigations/${investigation.id}/handoff`, {
    noteIds: [withNote.notes[0]!.id],
    insightIds: [],
  });
  assert.equal(updatedHandoffResponse.status, 200);
  const updatedHandoff = socialHandoffSchema.parse(await updatedHandoffResponse.json());
  assert.notEqual(updatedHandoff.creativeDirection, handoff.creativeDirection);
  const refinedResponse = await send(`/workflows/${workflow.id}/refine`, {
    expectedVersion: approved.version,
    research: updatedHandoff,
  });
  assert.equal(refinedResponse.status, 200, await refinedResponse.clone().text());
  const { workflow: refined } = workflowResponseSchema.parse(await refinedResponse.json());
  assert.deepEqual(refined.research, updatedHandoff);
  assert.deepEqual(refined.brief, creatorBrief);
  assert.equal(refined.input, creatorInput);
  assert.equal(refined.version, approved.version + 1);
  assert.equal(refined.contentRevision, approved.contentRevision + 1);
  assert.equal(refined.script, null);
  assert.equal(refined.scenes, null);
  assert.deepEqual(refined.approvals, { brief: null, script: null, scenes: null });
  const staleRefinement = await send(`/workflows/${workflow.id}/refine`, {
    expectedVersion: approved.version,
    research: handoff,
  });
  assert.equal(staleRefinement.status, 409);
  assert.equal((await staleRefinement.json()).error.code, 'WORKFLOW_VERSION_CONFLICT');

  await stop();
  await start();
  const persistedWorkflow = workflowResponseSchema.parse(
    await (await fetch(`${base}/workflows/${workflow.id}`)).json(),
  ).workflow;
  assert.deepEqual(persistedWorkflow, refined);
  const persistedProject = projectResponseSchema.parse(
    await (await fetch(`${base}/projects/${project.id}`)).json(),
  ).project;
  assert.deepEqual(persistedProject, changedProject);
  const persistedResearch = socialInvestigationResponseSchema.parse(
    await (await fetch(`${base}/social/investigations/${investigation.id}`)).json(),
  ).investigation;
  assert.match(persistedResearch.notes[0]!.text, /^Start with a visual demonstration/);
});

test('research-only refinement preserves creator facts without invoking the model', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yap-social-model-boundary-'));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: Server | undefined;
  let base = '';
  let refineCalls = 0;
  let conflictingSuggestions = false;
  const provider: VideoWorkflowProvider = {
    ...createWorkflowProvider({ provider: 'guided' }),
    name: 'openai',
    async refine(_workflow, input) {
      refineCalls++;
      if (input.message)
        return { brief: { tone: 'bold' }, message: 'The tone proposal is ready for review.' };
      return conflictingSuggestions
        ? {
            brief: {
              productName: 'Competitor product',
              productDescription: 'A claim from external research.',
              keyBenefits: ['An unsupported benefit from another business.'],
            },
            message: 'Conflicting model suggestions must not change creator facts.',
          }
        : { brief: {}, message: 'The supplied brief is ready for a proposal.' };
    },
  };
  async function start() {
    app = await createApp({
      dataFile: join(directory, 'projects.json'),
      socialProviderConfig: {},
      workflowProvider: provider,
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}/api/workflows`;
  }
  async function stop() {
    await app?.locals.shutdown?.();
    const active = server;
    if (active?.listening)
      await new Promise<void>((resolve, reject) =>
        active.close((error) => (error ? reject(error) : resolve())),
      );
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  const send = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const createdResponse = await send('', {
    title: 'Moss matcha promo',
    input: 'Make a promo for our made-to-order matcha latte.',
    brief: {
      productName: 'Moss Matcha',
      productDescription: 'Matcha latte from our shop.',
      keyBenefits: ['Made to order'],
      audience: 'Local matcha drinkers',
      callToAction: 'Visit our shop.',
    },
  });
  assert.equal(createdResponse.status, 201);
  const created = workflowResponseSchema.parse(await createdResponse.json()).workflow;
  const preparedResponse = await send(`/${created.id}/prepare`, {
    expectedVersion: created.version,
  });
  assert.equal(preparedResponse.status, 200);
  const prepared = workflowResponseSchema.parse(await preparedResponse.json()).workflow;
  const approvedResponse = await send(`/${created.id}/approve-all`, {
    expectedVersion: prepared.version,
  });
  assert.equal(approvedResponse.status, 200);
  const approved = workflowResponseSchema.parse(await approvedResponse.json()).workflow;
  const handoff = socialHandoffSchema.parse({
    investigationId: randomUUID(),
    topic: 'Matcha promo references',
    audience: 'People who enjoy matcha',
    creativeDirection: 'Adopt: Open with an original viewer question.',
    selectedNoteIds: [],
    selectedInsightIds: [],
    evidence: [],
    sourceUrls: [],
    cautions: ['External research guides framing, not product facts.'],
  });
  conflictingSuggestions = true;
  const callsBeforeResearch = refineCalls;
  const refinedResponse = await send(`/${created.id}/refine`, {
    expectedVersion: approved.version,
    research: handoff,
  });
  assert.equal(refinedResponse.status, 200, await refinedResponse.clone().text());
  const refined = workflowResponseSchema.parse(await refinedResponse.json()).workflow;
  assert.equal(refineCalls, callsBeforeResearch);
  assert.deepEqual(refined.brief, approved.brief);
  assert.equal(refined.input, approved.input);
  assert.deepEqual(refined.research, handoff);
  assert.equal(refined.version, approved.version + 1);
  assert.equal(refined.contentRevision, approved.contentRevision + 1);
  assert.equal(refined.script, null);
  assert.equal(refined.scenes, null);
  assert.deepEqual(refined.approvals, { brief: null, script: null, scenes: null });
  const staleResponse = await send(`/${created.id}/refine`, {
    expectedVersion: approved.version,
    research: handoff,
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'WORKFLOW_VERSION_CONFLICT');
  assert.equal(refineCalls, callsBeforeResearch);
  await stop();
  await start();
  const persisted = workflowResponseSchema.parse(
    await (await fetch(`${base}/${created.id}`)).json(),
  ).workflow;
  assert.deepEqual(persisted, refined);
  const explicitResponse = await send(`/${created.id}/refine`, {
    expectedVersion: persisted.version,
    message: 'Make the tone bolder.',
  });
  assert.equal(explicitResponse.status, 200);
  const explicit = workflowResponseSchema.parse(await explicitResponse.json()).workflow;
  assert.equal(refineCalls, callsBeforeResearch + 1);
  assert.equal(explicit.brief.tone, 'bold');
  assert.equal(explicit.brief.productName, approved.brief.productName);
});
