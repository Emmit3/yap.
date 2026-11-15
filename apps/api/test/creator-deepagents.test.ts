import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  creatorBudgetResponseSchema,
  creatorJobResponseSchema,
  creatorSessionSchema,
  creatorSessionResponseSchema,
  type CreatorResearch,
  type CreatorSessionResponse,
} from '@yap/contracts/creator';
import { workflowSchema } from '@yap/contracts/workflow';
import { createApp } from '../src/app.js';
import { creatorBudgetStateSchema } from '../src/creator-budget.js';
import { workflowProviderConfigFromEnv } from '../src/workflow-provider.js';

const evidenceId = 'public-film-one';
const authoredBrief =
  'MODEL_AUTHORED_RESEARCH_BRIEF_START\n' +
  'Adopt original wide-to-detail framing from the attributed outside example. '.repeat(40) +
  '\nMODEL_AUTHORED_RESEARCH_BRIEF_END; source public-film-one. Avoid outside product claims.';
const research: CreatorResearch = {
  summary: 'A model-authored creative brief over an attributed fixture source.',
  productFacts: [],
  cinematography: authoredBrief,
  sources: [
    {
      id: evidenceId,
      url: 'https://example.com/public-film',
      title: 'A documented public coffee film',
      kind: 'cinematography',
      excerpt: 'The outside film opens with a setting before a drink detail.',
    },
  ],
  references: [
    {
      id: 'opening-reference',
      sourceIds: [evidenceId],
      title: 'Wide-to-detail opening',
      hook: 'Establish a place before its details.',
      visualDirection: 'Adopt the shot progression in an original shop scene.',
      rationale: 'A spatial opening gives the creator a starting point to review.',
    },
  ],
  questions: [],
  limitations: ['The source supplies creative context and no creator product facts.'],
  execution: { harness: 'deepagents', model: 'gpt-6-luna' },
};
const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('HTTP shutdown aborts active SDK drafting and blocks later paid preparation', async (t) => {
  const prefix = join(tmpdir(), 'yap-creator-agent-shutdown-'),
    directory = await mkdtemp(prefix);
  let dispatches = 0,
    aborted = false,
    markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pausedOpenAI: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/chat/completions');
    dispatches++;
    const signal = init?.signal;
    assert.equal(Boolean(signal), true);
    if (!signal) throw new Error('The SDK request needs its composed cancellation signal.');
    markStarted();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        aborted = true;
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  };
  const noNetwork: typeof fetch = async () => {
    throw new Error('Only the paused simulated SDK request is allowed.');
  };
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    workflowProviderConfig: {
      provider: 'deepagents',
      apiKey: 'shutdown-fixture-key',
      model: 'gpt-6-luna',
      timeoutMs: 120000,
    },
    workflowFetch: pausedOpenAI,
    socialProviderConfig: {},
    socialFetch: noNetwork,
    creatorOptions: {
      videoConfig: { provider: 'fal', model: 'seedance-2.5', apiKey: '' },
      fetch: noNetwork,
      budgetLimitCents: 3000,
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(typeof address, 'object');
  if (!address || typeof address === 'string') throw new Error('The fixture server did not bind.');
  const base = `http://127.0.0.1:${address.port}/api/creator`;
  t.after(async () => {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.equal(resolve(directory).startsWith(resolve(prefix)), true);
    await rm(directory, { recursive: true, force: true });
  });
  const created = await localRequest(
    base + '/sessions',
    send('POST', {
      input: {
        mode: 'text',
        prompt: 'A matcha shop promo using creator-supplied facts.',
        urls: [],
        duration: 15,
        platform: 'instagram',
        tone: 'conversational',
      },
    }),
  );
  assert.equal(created.status, 201);
  let current = creatorSessionResponseSchema.parse(await created.json());
  const path = base + '/sessions/' + current.session.id;
  const answered = await localRequest(
    path,
    send('PATCH', {
      expectedVersion: current.session.version,
      answers: [
        { questionId: 'productName', answer: 'Mori Matcha' },
        { questionId: 'productDescription', answer: 'A neighborhood matcha shop.' },
        { questionId: 'audience', answer: 'Local matcha drinkers' },
        { questionId: 'keyBenefits', answer: 'A quiet place to meet friends' },
        { questionId: 'callToAction', answer: 'Visit us this weekend.' },
        { questionId: 'imageDirection', answer: 'An original shop opening.' },
      ],
    }),
  );
  assert.equal(answered.status, 200);
  current = creatorSessionResponseSchema.parse(await answered.json());
  const versions = {
    expectedVersion: current.session.version,
    expectedWorkflowVersion: current.workflow.version,
  };
  const preparing = localRequest(path + '/prepare', send('POST', versions));
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      new Promise<void>((_resolve, reject) => {
        startTimer = setTimeout(
          () => reject(new Error('The simulated SDK transport did not start.')),
          130000,
        );
      }),
    ]);
  } finally {
    clearTimeout(startTimer);
  }
  assert.equal(dispatches, 1);
  await app.locals.shutdown();
  const interrupted = await preparing;
  assert.equal(aborted, true, 'shutdown reaches the active ChatOpenAI transport signal');
  assert.equal(interrupted.status, 408);
  const failure = await interrupted.json();
  assert.equal(failure.error.code, 'REQUEST_CANCELED');
  assert.equal(dispatches, 1, 'shutdown never dispatches another model request');
  const storedWorkflows = JSON.parse(await readFile(join(directory, 'workflows.json'), 'utf8'));
  const savedWorkflow = workflowSchema.parse(storedWorkflows.workflows[0]);
  assert.equal(savedWorkflow.script, null);
  assert.equal(savedWorkflow.scenes, null);
  assert.equal(savedWorkflow.approvals.script, null);
  assert.equal(savedWorkflow.approvals.scenes, null);
  const storedCreator = JSON.parse(
    await readFile(join(directory, 'creator-sessions.json'), 'utf8'),
  );
  const savedSession = creatorSessionSchema.parse(storedCreator.sessions[0]);
  assert.equal(savedSession.approval, null);
  assert.equal(savedSession.plan, null);
  const rejected = await localRequest(path + '/prepare', send('POST', versions));
  assert.equal(rejected.status, 503);
  assert.equal(dispatches, 1);
});
function localRequest(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    // Script and scene agents each have a 120-second server deadline.
    signal: AbortSignal.timeout(url.endsWith('/prepare') ? 250000 : 10000),
  });
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

/** Read only the explicitly framed authoritative JSON from a real SDK request. */
function productionSource(messages: Array<{ content: unknown }>) {
  const marker = 'Authoritative source JSON:\n';
  const text = messages
    .map((message) => textContent(message.content))
    .find((text) => text.includes(marker));
  assert.ok(text, 'the specialist receives the authoritative source context');
  const tail = text.slice(text.indexOf(marker) + marker.length);
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < tail.length; index++) {
    const character = tail[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      const source = JSON.parse(tail.slice(0, index + 1));
      return {
        operation: source.operation as string,
        workflow: workflowSchema.parse(source.workflow),
      };
    }
  }
  throw new Error('The authoritative workflow JSON was incomplete.');
}

test('Deep Agents environment selection normalizes the OpenAI model prefix and chooses the research key override', () => {
  const config = workflowProviderConfigFromEnv({
    WORKFLOW_PROVIDER: 'deepagents',
    DEEPAGENTS_MODEL: 'openai:gpt-6-luna',
    DEEPAGENTS_OPENAI_API_KEY: 'agent-fixture-key',
    OPENAI_API_KEY: 'ordinary-fixture-key',
  });
  assert.equal(config.provider, 'deepagents');
  assert.equal(config.model, 'gpt-6-luna');
  assert.equal(config.apiKey, 'agent-fixture-key');
});

test('HTTP creator preparation uses real ChatOpenAI SDK delegation and accounts once per request, then reuses saved drafts', async (t) => {
  const prefix = join(tmpdir(), 'yap-creator-deepagents-'),
    directory = await mkdtemp(prefix),
    calls: Array<Record<string, unknown>> = [],
    operations: string[] = [];
  let researchCalls = 0;
  const fakeOpenAI: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer agent-fixture-key');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-6-luna');
    assert.notEqual(body.stream, true, 'the ordinary SDK invoke uses nonstreaming JSON');
    assert.equal(body.service_tier, 'default');
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_completion_tokens, 4000);
    assert.equal(body.max_tokens, undefined);
    calls.push(body);
    const step = (calls.length - 1) % 10,
      scenes = calls.length > 10,
      writer = scenes ? 'scene_director' : 'script_writer',
      reviewer = scenes ? 'scene_reviewer' : 'script_reviewer';
    let name: string | undefined,
      args: Record<string, unknown> = {};
    if (step === 0 || step === 8) {
      name = 'write_todos';
      args = {
        todos: [
          { content: 'Draft original material', status: step === 0 ? 'in_progress' : 'completed' },
          {
            content: 'Independently review the saved draft',
            status: step === 0 ? 'pending' : 'completed',
          },
        ],
      };
    } else if (step === 1 || step === 4) {
      name = 'task';
      args = {
        subagent_type: step === 1 ? writer : reviewer,
        description:
          step === 1
            ? 'Use the supplied creator facts and attributed research to submit an original draft.'
            : 'Read /production/draft.json, compare source facts and timing, then submit the independent review.',
      };
    } else if (step === 2) {
      const source = productionSource(body.messages);
      operations.push(source.operation);
      assert.equal(source.workflow.brief.productName, 'Mori Matcha');
      assert.equal(source.workflow.brief.callToAction, 'Visit us this weekend.');
      assert.ok(source.workflow.research?.evidence.some((item) => item.postId === evidenceId));
      assert.ok(
        source.workflow.research?.creativeDirection.includes(authoredBrief),
        'the complete model-authored creator research brief reaches the real script/scene SDK request',
      );
      assert.ok(
        source.workflow.research?.evidence.some(
          (item) => item.postId === evidenceId && item.url === research.sources[0]!.url,
        ),
      );
      const attribution = {
        researchEvidenceIds: [evidenceId],
        researchNotes:
          'Adopt the external wide-to-detail opening as structure only; the creator supplied every shop fact.',
      };
      if (scenes) {
        name = 'submit_scene_draft';
        assert.ok(source.workflow.script);
        args = {
          scenes: source.workflow.script.segments.map((segment) => ({
            scriptSegmentId: segment.id,
            seconds: segment.seconds,
            visual:
              'An original wide-to-detail shot of the matcha shop; no outside product claims.',
            onScreenText: '',
            assetIds: [],
          })),
          ...attribution,
        };
      } else {
        name = 'submit_script_draft';
        args = {
          hook: 'Make time for matcha.',
          segments: [
            { text: 'Make time for matcha.', seconds: 5 },
            { text: 'Meet a friend at Mori Matcha.', seconds: 5 },
            { text: 'Visit us this weekend.', seconds: 5 },
          ],
          caption: 'A neighborhood moment at Mori Matcha.',
          ...attribution,
        };
      }
    } else if (step === 5) {
      name = 'read_file';
      args = { file_path: '/production/draft.json', offset: 0, limit: 100 };
    } else if (step === 6) {
      name = scenes ? 'review_scene_draft' : 'review_script_draft';
      args = {
        accepted: true,
        summary: 'Original wording, supplied facts, attribution and exact segment timing reviewed.',
      };
    }
    const message = {
      role: 'assistant',
      content: name
        ? null
        : 'The requested production stage is complete and still requires creator approval.',
      ...(name
        ? {
            tool_calls: [
              {
                id: `http-tool-${calls.length}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          }
        : {}),
    };
    return Response.json({
      id: `chatcmpl-fixture-${calls.length}`,
      object: 'chat.completion',
      created: 1794744000,
      model: 'gpt-6-luna',
      choices: [{ index: 0, message, finish_reason: name ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
  };
  const noNetwork: typeof fetch = async () => {
    throw new Error(
      'No live research, image, speech or video request is allowed in this HTTP test.',
    );
  };
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    workflowProviderConfig: {
      ...workflowProviderConfigFromEnv({
        WORKFLOW_PROVIDER: 'deepagents',
        DEEPAGENTS_MODEL: 'openai:gpt-6-luna',
        DEEPAGENTS_OPENAI_API_KEY: 'agent-fixture-key',
      }),
      timeoutMs: 120000,
    },
    workflowFetch: fakeOpenAI,
    socialProviderConfig: {},
    socialFetch: noNetwork,
    creatorOptions: {
      analyze: async () => {
        researchCalls++;
        return structuredClone(research);
      },
      videoConfig: { provider: 'fal', model: 'seedance-2.5', apiKey: '' },
      fetch: noNetwork,
      budgetLimitCents: 3000,
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
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  async function envelope(response: Response, status = 200): Promise<CreatorSessionResponse> {
    assert.equal(response.status, status, await response.clone().text());
    return creatorSessionResponseSchema.parse(await response.json());
  }
  let current = await envelope(
    await localRequest(
      base + '/sessions',
      send('POST', {
        input: {
          mode: 'text',
          prompt: 'A cinematic promo for our neighborhood matcha shop.',
          urls: [],
          duration: 15,
          platform: 'instagram',
          tone: 'conversational',
        },
        research: {
          investigationId: randomUUID(),
          topic: 'Wide-to-detail openings',
          audience: 'Local visitors',
          creativeDirection: 'Adopt structure while using original wording and creator facts.',
          selectedNoteIds: [],
          selectedInsightIds: [],
          evidence: [
            {
              postId: 'analytics-film-one',
              url: 'https://example.com/analytics-film',
              excerpt: 'An outside film opens wide, then shows a detail.',
            },
          ],
          sourceUrls: ['https://example.com/analytics-film'],
          cautions: ['This outside source provides no product facts about Mori Matcha.'],
        },
      }),
    ),
    201,
  );
  const path = base + '/sessions/' + current.session.id;
  current = await envelope(
    await localRequest(
      path,
      send('PATCH', {
        expectedVersion: current.session.version,
        answers: [
          { questionId: 'productName', answer: 'Mori Matcha' },
          { questionId: 'productDescription', answer: 'A neighborhood matcha shop.' },
          { questionId: 'audience', answer: 'Local matcha drinkers' },
          { questionId: 'keyBenefits', answer: 'A quiet place to meet friends' },
          { questionId: 'callToAction', answer: 'Visit us this weekend.' },
          { questionId: 'imageDirection', answer: 'An original wide-to-detail opening.' },
        ],
      }),
    ),
  );
  assert.equal(calls.length, 0);
  const analyzed = await localRequest(
    path + '/analyze',
    send('POST', {
      expectedVersion: current.session.version,
    }),
  );
  assert.equal(analyzed.status, 202, await analyzed.clone().text());
  const started = creatorJobResponseSchema.parse(await analyzed.json());
  let researchDone = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = creatorJobResponseSchema.parse(
      await (await localRequest(path + '/jobs/' + started.job.id)).json(),
    ).job;
    if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
      assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
      researchDone = true;
      break;
    }
    await delay(5);
  }
  assert.ok(researchDone, 'the bounded creator analysis job completes');
  assert.equal(researchCalls, 1);
  current = await envelope(await localRequest(path));
  assert.equal(current.session.research?.cinematography, authoredBrief);
  assert.deepEqual(current.session.research?.productFacts, []);
  current = await envelope(
    await localRequest(
      path,
      send('PATCH', {
        expectedVersion: current.session.version,
        selectedReferenceIds: ['opening-reference'],
      }),
    ),
  );
  assert.equal(calls.length, 0);
  const staleVersion = {
    expectedVersion: current.session.version,
    expectedWorkflowVersion: current.workflow.version,
  };
  current = await envelope(await localRequest(path + '/prepare', send('POST', staleVersion)));
  assert.equal(calls.length, 20);
  assert.deepEqual(operations, ['script', 'scenes']);
  assert.equal(current.workflow.script?.provider, 'deepagents');
  assert.equal(current.workflow.scenes?.provider, 'deepagents');
  assert.deepEqual(current.workflow.script?.agentRun?.specialists, [
    'script_writer',
    'script_reviewer',
  ]);
  assert.deepEqual(current.workflow.scenes?.agentRun?.specialists, [
    'scene_director',
    'scene_reviewer',
  ]);
  assert.equal(current.workflow.script?.agentRun?.modelCalls, 10);
  assert.equal(current.workflow.scenes?.agentRun?.modelCalls, 10);
  assert.deepEqual(current.workflow.script?.agentRun?.researchEvidenceIds, [evidenceId]);
  assert.ok(
    current.workflow.script?.agentRun?.researchContext?.evidence.some(
      (item) => item.postId === evidenceId && item.url === research.sources[0]!.url,
    ),
  );
  assert.ok(
    current.workflow.scenes?.agentRun?.researchContext?.creativeDirection.includes(authoredBrief),
  );
  assert.equal(
    current.workflow.script?.agentRun?.researchContext?.creativeDirection.includes(authoredBrief),
    true,
  );
  assert.ok(
    current.workflow.research?.evidence.some((item) => item.postId === 'analytics-film-one'),
  );
  assert.equal(current.workflow.brief.productDescription, 'A neighborhood matcha shop.');
  assert.ok(current.session.plan);
  assert.equal(current.session.approval, null);
  assert.equal(current.workflow.approvals.script, null);
  assert.equal(current.workflow.approvals.scenes, null);
  const budget = creatorBudgetResponseSchema.parse(
    await (await localRequest(base + '/budget')).json(),
  ).budget;
  assert.equal(budget.reservedCents, 0);
  assert.equal(budget.chargedCents, 20);
  const stored = JSON.parse(await readFile(join(directory, 'creator-sessions.json'), 'utf8'));
  const ledger = creatorBudgetStateSchema.parse(stored.budget);
  assert.equal(ledger.reservations.length, 20, 'one reservation per actual model request');
  assert.equal(
    new Set(ledger.reservations.map((reservation) => reservation.idempotencyKey)).size,
    20,
  );
  assert.ok(
    ledger.reservations.every(
      (reservation) =>
        reservation.category === 'drafting' &&
        reservation.amountCents === 50 &&
        reservation.chargedCents === 1,
    ),
  );
  const scriptId = current.workflow.script!.id,
    scenesId = current.workflow.scenes!.id;
  current = await envelope(
    await localRequest(
      path + '/prepare',
      send('POST', {
        expectedVersion: current.session.version,
        expectedWorkflowVersion: current.workflow.version,
      }),
    ),
  );
  assert.equal(current.workflow.script?.id, scriptId);
  assert.equal(current.workflow.scenes?.id, scenesId);
  assert.equal(calls.length, 20, 'preparing saved stages makes no additional paid call');
  const stale = await localRequest(path + '/prepare', send('POST', staleVersion));
  assert.equal(stale.status, 409);
  assert.equal(calls.length, 20, 'stale preparation fails before model transport');
  assert.deepEqual(
    creatorBudgetResponseSchema.parse(await (await localRequest(base + '/budget')).json()).budget,
    budget,
  );
});
