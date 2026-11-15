import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import {
  socialDatasetSchema,
  socialResearchEventInputSchema,
  socialResearchRunInputSchema,
  type SocialResearchArtifactPath,
  type SocialResearchEventInput,
} from '@yap/contracts/social';
import { ApiError } from '../src/errors.js';
import { runSocialDeepAgents, socialDeepAgentsAvailable } from '../src/social-deepagents.js';

interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** Executes the real harness and tools; only chat model responses are deterministic. */
class ScriptedResearchModel extends BaseChatModel {
  calls = 0;
  readonly fileReads: string[] = [];
  constructor(private readonly script: ScriptedCall[][]) {
    super({});
  }
  _llmType() {
    return 'scripted-public-research';
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const last = messages.at(-1);
    if (ToolMessage.isInstance(last) && last.name === 'read_file')
      this.fileReads.push(
        typeof last.content === 'string'
          ? last.content
          : last.content
              .flatMap((block) =>
                typeof block === 'object' &&
                block !== null &&
                block.type === 'text' &&
                'text' in block &&
                typeof block.text === 'string'
                  ? [block.text]
                  : [],
              )
              .join('\n'),
      );
    const toolCalls = this.script[this.calls++] ?? [];
    const message = new AIMessage({
      content: 'PRIVATE_MODEL_OUTPUT_MUST_NOT_REACH_ACTIVITY_OR_ARTIFACTS',
      tool_calls: toolCalls,
    });
    return { generations: [{ text: String(message.content), message }] };
  }
}

let callId = 0;
function call(name: string, args: Record<string, unknown> = {}): ScriptedCall[] {
  return [{ name, args, id: `scripted-call-${callId++}` }];
}
const synthesis = {
  summary: 'Open with a visible coffee comparison, then explain one practical choice.',
  decisions: [
    {
      evidenceIds: ['p1', 'p2'],
      adopt: 'Demonstrate the difference using the creator’s own coffee footage.',
      avoid: 'Avoid copying source wording or claiming that engagement proves quality.',
      test: 'Test a comparison opening against a direct product detail.',
    },
  ],
};
function script(brief: Record<string, unknown> = synthesis): ScriptedCall[][] {
  return [
    call('write_todos', {
      todos: [
        { content: 'Collect public sources', status: 'in_progress' },
        { content: 'Analyze observed links', status: 'pending' },
        { content: 'Draft creative framing', status: 'pending' },
      ],
    }),
    call('task', {
      subagent_type: 'source_researcher',
      description:
        'Read /research/scope.json, collect_public_sources, and inspect /research/sources.json.',
    }),
    call('read_file', { file_path: '/research/scope.json', offset: 0, limit: 100 }),
    call('collect_public_sources'),
    call('collect_public_sources'),
    call('read_file', { file_path: '/research/sources.json', offset: 0, limit: 100 }),
    [],
    call('task', {
      subagent_type: 'network_analyst',
      description:
        'Inspect /research/sources.json, analyze_observed_network, and read /research/network.json.',
    }),
    call('read_file', { file_path: '/research/sources.json', offset: 0, limit: 100 }),
    call('analyze_observed_network'),
    call('read_file', { file_path: '/research/network.json', offset: 0, limit: 100 }),
    [],
    call('task', {
      subagent_type: 'creative_strategist',
      description:
        'Read /research/network.json, build_creative_brief, and inspect /research/brief.md.',
    }),
    call('read_file', { file_path: '/research/sources.json', offset: 0, limit: 100 }),
    call('read_file', { file_path: '/research/network.json', offset: 0, limit: 100 }),
    call('build_creative_brief', brief),
    call('read_file', { file_path: '/research/brief.md', offset: 0, limit: 100 }),
    [],
    call('write_todos', {
      todos: [
        { content: 'Collect public sources', status: 'completed' },
        { content: 'Analyze observed links', status: 'completed' },
        { content: 'Draft creative framing', status: 'completed' },
      ],
    }),
    [],
  ];
}

const now = '2026-11-13T18:00:00.000Z';
const data = socialDatasetSchema.parse({
  actors: [
    {
      id: 'actor1',
      platform: 'x',
      name: 'Public source one',
      handle: '@sourceone',
      url: 'https://x.com/sourceone',
    },
    {
      id: 'actor2',
      platform: 'x',
      name: 'Public source two',
      handle: '@sourcetwo',
      url: 'https://x.com/sourcetwo',
    },
  ],
  posts: [
    {
      id: 'p1',
      platform: 'x',
      url: 'https://x.com/sourceone/status/123',
      actorId: 'actor1',
      text: 'Three coffee mistakes shown with a practical comparison for beginners.',
      publishedAt: now,
      collectedAt: now,
      provider: 'import',
      contentKind: 'post',
      metrics: { likes: 17, replies: 2, shares: 4, views: null },
    },
    {
      id: 'p2',
      platform: 'x',
      url: 'https://x.com/sourcetwo/status/124',
      actorId: 'actor2',
      text: 'This coffee comparison makes a beginner mistake easier to see.',
      publishedAt: now,
      collectedAt: now,
      provider: 'import',
      contentKind: 'post',
      metrics: { likes: 9, replies: 1, shares: 2, views: null },
    },
  ],
  relationships: [
    {
      id: 'edge1',
      sourcePostId: 'p2',
      targetPostId: 'p1',
      targetActorId: null,
      kind: 'repost',
      observedAt: now,
    },
  ],
  warnings: ['The fixture represents a bounded public sample.'],
});
const input = socialResearchRunInputSchema.parse({
  topic: 'Coffee comparisons',
  platforms: ['x'],
  mode: 'live',
  harness: 'deepagents',
  limit: 20,
});

test('real Deep Agents planning, three delegated specialists, and shared filesystem tools preserve immutable public evidence', async () => {
  const events: SocialResearchEventInput[] = [];
  const artifacts = new Map<SocialResearchArtifactPath, string>();
  const model = new ScriptedResearchModel(script());
  let searches = 0;
  const returned = await runSocialDeepAgents(
    {
      input,
      signal: new AbortController().signal,
      emit: (event) => events.push(socialResearchEventInputSchema.parse(event)),
      writeArtifact: (path, content) => artifacts.set(path, content),
      collect: async (scope, signal) => {
        searches++;
        assert.equal(scope.topic, input.topic);
        assert.equal(signal.aborted, false);
        return structuredClone(data);
      },
    },
    { model, config: { timeoutMs: 10000, maxModelCalls: 24 } },
  );
  assert.deepEqual(returned, data);
  assert.equal(searches, 1);
  assert.equal(model.calls, 20);
  assert.ok(model.fileReads.some((content) => content.includes('Coffee comparisons')));
  assert.ok(model.fileReads.some((content) => content.includes('"totalPosts": 2')));
  assert.ok(model.fileReads.some((content) => content.includes('"observedRelationshipCount": 1')));
  assert.ok(model.fileReads.some((content) => content.includes('creator must select')));
  for (const name of ['source_researcher', 'network_analyst', 'creative_strategist']) {
    assert.ok(events.some((event) => event.agent === name && event.phase === 'started'));
    assert.ok(events.some((event) => event.agent === name && event.phase === 'completed'));
  }
  assert.ok(
    events.some((event) => event.agent === 'coordinator' && event.message.includes('task plan')),
  );
  assert.ok(events.some((event) => event.message.includes('No duplicate source search')));
  assert.ok(events.some((event) => event.message.includes('shared virtual filesystem')));
  assert.equal(artifacts.size, 5);
  assert.equal(JSON.parse(artifacts.get('/research/sources.json')!).totalPosts, 2);
  assert.equal(
    JSON.parse(artifacts.get('/research/network.json')!).coverage.observedRelationshipCount,
    1,
  );
  assert.ok(artifacts.get('/research/brief.md')!.includes('creator must select'));
  assert.match(artifacts.get('/research/brief.md')!, /Model-proposed creative framing/u);
  assert.ok(artifacts.get('/research/brief.md')!.includes(synthesis.summary));
  assert.ok(artifacts.get('/research/brief.md')!.includes(synthesis.decisions[0]!.adopt));
  assert.ok(artifacts.get('/research/brief.md')!.includes(data.posts[0]!.url));
  for (const content of artifacts.values()) assert.ok(Buffer.byteLength(content) <= 64 * 1024);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_MODEL_OUTPUT'));
  assert.ok(!JSON.stringify([...artifacts]).includes('PRIVATE_MODEL_OUTPUT'));
});

test('model synthesis cannot cite invented evidence or omit evidence for a nonempty collected batch', async () => {
  for (const decisions of [[{ ...synthesis.decisions[0]!, evidenceIds: ['not-collected'] }], []]) {
    const artifacts = new Map<SocialResearchArtifactPath, string>();
    await assert.rejects(
      runSocialDeepAgents(
        {
          input,
          signal: new AbortController().signal,
          emit: () => undefined,
          writeArtifact: (path, content) => artifacts.set(path, content),
          collect: async () => structuredClone(data),
        },
        {
          model: new ScriptedResearchModel(script({ ...synthesis, decisions })),
          config: { timeoutMs: 10000, maxModelCalls: 24 },
        },
      ),
      (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_SYNTHESIS',
    );
    assert.equal(artifacts.has('/research/brief.md'), false);
    assert.deepEqual(
      JSON.parse(artifacts.get('/research/sources.json')!).posts.map(
        (post: { id: string }) => post.id,
      ),
      ['p1', 'p2'],
    );
  }
});

test('an empty batch permits an explicit limitation without invented evidence-backed decisions', async () => {
  const empty = { posts: [], actors: [], relationships: [], warnings: [] },
    artifacts = new Map<SocialResearchArtifactPath, string>();
  const returned = await runSocialDeepAgents(
    {
      input,
      signal: new AbortController().signal,
      emit: () => undefined,
      writeArtifact: (path, content) => artifacts.set(path, content),
      collect: async () => empty,
    },
    {
      model: new ScriptedResearchModel(
        script({ summary: 'No public evidence was collected for this scope.', decisions: [] }),
      ),
      config: { timeoutMs: 10000 },
    },
  );
  assert.deepEqual(returned, empty);
  assert.match(
    artifacts.get('/research/brief.md')!,
    /No public evidence was collected; no evidence-backed decisions/u,
  );
  assert.equal(artifacts.size, 5);
});

test('oversized synthesis rejects rather than truncating exact evidence URLs', async () => {
  const dataset = socialDatasetSchema.parse({
      ...data,
      posts: Array.from({ length: 4 }, (_, index) => ({
        ...data.posts[0]!,
        id: `p${index + 1}`,
        url: `https://example.org/${index}/${'x'.repeat(1900)}`,
      })),
    }),
    artifacts = new Map<SocialResearchArtifactPath, string>();
  const proposed = {
    summary: synthesis.summary,
    decisions: Array.from({ length: 4 }, () => ({
      ...synthesis.decisions[0]!,
      evidenceIds: dataset.posts.map((post) => post.id),
    })),
  };
  await assert.rejects(
    runSocialDeepAgents(
      {
        input,
        signal: new AbortController().signal,
        emit: () => undefined,
        writeArtifact: (path, content) => artifacts.set(path, content),
        collect: async () => dataset,
      },
      { model: new ScriptedResearchModel(script(proposed)), config: { timeoutMs: 10000 } },
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_SYNTHESIS',
  );
  assert.equal(artifacts.has('/research/brief.md'), false);
  assert.deepEqual(
    JSON.parse(artifacts.get('/research/sources.json')!).posts.map(
      (post: { url: string }) => post.url,
    ),
    dataset.posts.map((post) => post.url),
  );
});

test('concurrent conflicting model submissions cannot replace the accepted creative brief', async () => {
  const steps = script();
  steps[15] = [
    ...call('build_creative_brief', synthesis),
    ...call('build_creative_brief', { ...synthesis, summary: 'A conflicting second version.' }),
  ];
  await assert.rejects(
    runSocialDeepAgents(
      {
        input,
        signal: new AbortController().signal,
        emit: () => undefined,
        writeArtifact: () => undefined,
        collect: async () => structuredClone(data),
      },
      { model: new ScriptedResearchModel(steps), config: { timeoutMs: 10000 } },
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_SYNTHESIS',
  );
});

test('missing configuration and demonstration mode never start live model or provider work', async () => {
  assert.equal(socialDeepAgentsAvailable({}).configured, false);
  assert.equal(socialDeepAgentsAvailable({ model: 'configured-model' }).configured, false);
  assert.equal(
    socialDeepAgentsAvailable({ model: 'configured-model', apiKey: 'server-secret' }).configured,
    true,
  );
  assert.ok(
    !JSON.stringify(
      socialDeepAgentsAvailable({ model: 'configured-model', apiKey: 'server-secret' }),
    ).includes('server-secret'),
  );
  let searches = 0;
  const context = {
    input,
    signal: new AbortController().signal,
    emit: () => undefined,
    writeArtifact: () => undefined,
    collect: async () => {
      searches++;
      return data;
    },
  };
  await assert.rejects(
    runSocialDeepAgents(context, { config: {} }),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_NOT_CONFIGURED',
  );
  await assert.rejects(
    runSocialDeepAgents(
      { ...context, input: { ...input, mode: 'demo' } },
      { model: new ScriptedResearchModel(script()) },
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_DEMO_MODE',
  );
  assert.equal(searches, 0);
});

test('a model that skips delegation is rejected rather than presented as completed research', async () => {
  let searches = 0;
  await assert.rejects(
    runSocialDeepAgents(
      {
        input,
        signal: new AbortController().signal,
        emit: () => undefined,
        writeArtifact: () => undefined,
        collect: async () => {
          searches++;
          return data;
        },
      },
      { model: new ScriptedResearchModel([[]]), config: { timeoutMs: 10000 } },
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_INCOMPLETE',
  );
  assert.equal(searches, 0);
});

test('model-call budget and cancellation stop the harness without leaking private errors', async () => {
  const context = {
    input,
    signal: new AbortController().signal,
    emit: () => undefined,
    writeArtifact: () => undefined,
    collect: async () => data,
  };
  await assert.rejects(
    runSocialDeepAgents(context, {
      model: new ScriptedResearchModel(script()),
      config: { maxModelCalls: 1, timeoutMs: 10000 },
    }),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_BUDGET',
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    runSocialDeepAgents(
      { ...context, signal: abort.signal },
      { model: new ScriptedResearchModel(script()) },
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_CANCELED',
  );
});

test('SDK general-purpose and unknown subagents cannot bypass the shared research budget', async () => {
  for (const subagentType of ['general-purpose', 'unexpected_specialist']) {
    const model = new ScriptedResearchModel([
      call('write_todos', {
        todos: [{ content: 'Collect public evidence', status: 'in_progress' }],
      }),
      call('task', {
        subagent_type: subagentType,
        description: 'Read /research/scope.json repeatedly.',
      }),
      ...Array.from({ length: 4 }, () => call('read_file', { file_path: '/research/scope.json' })),
      [],
    ]);
    let searches = 0;
    await assert.rejects(
      runSocialDeepAgents(
        {
          input,
          signal: new AbortController().signal,
          emit: () => undefined,
          writeArtifact: () => undefined,
          collect: async () => {
            searches++;
            return data;
          },
        },
        { model, config: { maxModelCalls: 2, timeoutMs: 10000 } },
      ),
      (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_DELEGATION',
    );
    assert.equal(model.calls, 2);
    assert.equal(searches, 0);
  }
});

test('the model-call budget includes named specialists as well as the coordinator', async () => {
  const model = new ScriptedResearchModel(script());
  let searches = 0;
  await assert.rejects(
    runSocialDeepAgents(
      {
        input,
        signal: new AbortController().signal,
        emit: () => undefined,
        writeArtifact: () => undefined,
        collect: async () => {
          searches++;
          return data;
        },
      },
      { model, config: { maxModelCalls: 3, timeoutMs: 10000 } },
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_BUDGET',
  );
  assert.equal(model.calls, 3);
  assert.equal(searches, 0);
});

test('a batch of filesystem tool calls cannot exceed the shared tool budget', async () => {
  const model = new ScriptedResearchModel([
    Array.from({ length: 49 }, () => call('read_file', { file_path: '/research/scope.json' })[0]!),
    [],
  ]);
  await assert.rejects(
    runSocialDeepAgents(
      {
        input,
        signal: new AbortController().signal,
        emit: () => undefined,
        writeArtifact: () => undefined,
        collect: async () => data,
      },
      { model, config: { maxModelCalls: 2, timeoutMs: 10000 } },
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AGENT_BUDGET',
  );
  assert.equal(model.calls, 1);
});
