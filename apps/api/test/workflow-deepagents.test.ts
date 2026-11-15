import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { workflowSchema, type Workflow } from '@yap/contracts/workflow';
import { ApiError } from '../src/errors.js';
import { createWorkflowDeepAgentsProvider } from '../src/workflow-deepagents.js';

interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** Only model responses are fixtures: the real SDK graph and tools still execute. */
class ScriptedWorkflowModel extends BaseChatModel {
  calls = 0;
  readonly received: BaseMessage[][] = [];
  onCall?: () => void;
  constructor(private readonly responses: ScriptedCall[][]) {
    super({});
  }
  _llmType() {
    return 'scripted-workflow-deepagents';
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.received.push(messages);
    const toolCalls = this.responses[this.calls++] ?? [];
    this.onCall?.();
    const message = new AIMessage({
      content: 'PRIVATE_SCRIPT_MODEL_TEXT_MUST_NOT_BECOME_A_RECEIPT',
      tool_calls: toolCalls,
    });
    return { generations: [{ text: String(message.content), message }] };
  }
}

let nextCall = 0;
function call(name: string, args: Record<string, unknown> = {}): ScriptedCall[] {
  return [{ name, args, id: `workflow-call-${nextCall++}` }];
}
const now = '2026-11-15T12:00:00.000Z';
const evidenceId = 'coffee-study-1';
function workflow(): Workflow {
  return workflowSchema.parse({
    id: randomUUID(),
    version: 7,
    contentRevision: 3,
    title: 'Mori matcha',
    input: 'Make an original promo for Mori Matcha using our own shop facts.',
    brief: {
      productName: 'Mori Matcha',
      productDescription: 'A neighborhood matcha shop.',
      audience: 'Local matcha drinkers',
      keyBenefits: ['A quiet place to meet friends'],
      callToAction: 'Visit us this weekend.',
      imageDirection: 'Use our supplied drink photo.',
      platform: 'instagram',
      tone: 'conversational',
      duration: 15,
    },
    research: {
      investigationId: randomUUID(),
      topic: 'How public coffee films introduce a setting',
      audience: 'Local visitors',
      creativeDirection: 'Adopt a wide-to-detail opening, using original words and shop facts.',
      selectedNoteIds: [],
      selectedInsightIds: ['opening-pattern'],
      evidence: [
        {
          postId: evidenceId,
          url: 'https://example.com/public-coffee-film',
          excerpt: 'An external coffee film uses a wide establishing shot before a cup detail.',
        },
      ],
      sourceUrls: ['https://example.com/public-coffee-film'],
      cautions: ['This example does not prove anything about Mori Matcha or predict reach.'],
    },
    assets: [
      {
        id: randomUUID(),
        filename: 'matcha.png',
        mimeType: 'image/png',
        bytes: 123,
        width: 32,
        height: 32,
        sha256: 'a'.repeat(64),
        description: 'A creator-supplied photo of the drink.',
        createdAt: now,
      },
    ],
    messages: [],
    questions: [],
    script: null,
    scenes: null,
    approvals: { brief: 3, script: null, scenes: null },
    createdAt: now,
    updatedAt: now,
  });
}

function scriptDraft() {
  return {
    hook: 'Make time for matcha.',
    segments: [
      { text: 'Make time for matcha.', seconds: 5 },
      { text: 'Meet a friend at Mori Matcha.', seconds: 5 },
      { text: 'Visit us this weekend.', seconds: 5 },
    ],
    caption: 'A neighborhood moment at Mori Matcha.',
    researchEvidenceIds: [evidenceId],
    researchNotes:
      'The attributed external film informed wide-to-detail structure only; shop facts came from the creator.',
  };
}

function workflowWithScript(): Workflow {
  const source = workflow();
  source.script = {
    id: randomUUID(),
    sourceRevision: source.contentRevision,
    hook: scriptDraft().hook,
    caption: scriptDraft().caption,
    segments: scriptDraft().segments.map((segment) => ({ ...segment, id: randomUUID() })),
    provider: 'guided',
    createdAt: now,
  };
  source.approvals.script = source.script.id;
  return source;
}

function sceneDraft(source: Workflow) {
  assert.ok(source.script);
  return {
    scenes: source.script.segments.map((segment, index) => ({
      scriptSegmentId: segment.id,
      seconds: segment.seconds,
      visual: index === 0 ? 'Wide shop setting using the supplied photo.' : 'Original cup detail.',
      onScreenText: '',
      assetIds: [source.assets[0]!.id],
    })),
    researchEvidenceIds: [evidenceId],
    researchNotes:
      'External shot structure is inspiration; all product facts and images remain creator supplied.',
  };
}

function delegation(
  writer: string,
  writeTool: string,
  draft: Record<string, unknown>,
  reviewer: string,
  reviewTool: string,
  accepted = true,
): ScriptedCall[][] {
  return [
    call('write_todos', {
      todos: [
        { content: 'Write an original draft from creator facts', status: 'in_progress' },
        { content: 'Review attribution and timing', status: 'pending' },
      ],
    }),
    call('task', { subagent_type: writer, description: `Use ${writeTool} to submit the draft.` }),
    call(writeTool, draft),
    [],
    call('task', {
      subagent_type: reviewer,
      description: `Use ${reviewTool} to review the draft.`,
    }),
    call('read_file', { file_path: '/production/draft.json', offset: 0, limit: 100 }),
    call(reviewTool, {
      accepted,
      summary: accepted
        ? 'Creator facts retained, external references attributed, and all timings checked.'
        : 'The proposed draft needs another creator review.',
    }),
    [],
    call('write_todos', {
      todos: [
        { content: 'Write an original draft from creator facts', status: 'completed' },
        { content: 'Review attribution and timing', status: 'completed' },
      ],
    }),
    [],
  ];
}
function scriptResponses(draft: Record<string, unknown> = scriptDraft(), accepted = true) {
  return delegation(
    'script_writer',
    'submit_script_draft',
    draft,
    'script_reviewer',
    'review_script_draft',
    accepted,
  );
}
function provider(model: ScriptedWorkflowModel, maxModelCalls = 16) {
  return createWorkflowDeepAgentsProvider(
    {
      provider: 'deepagents',
      apiKey: 'fixture-key',
      model: 'gpt-6-luna',
      timeoutMs: 10000,
      maxModelCalls,
    },
    {
      model,
      fetch: async () => {
        throw new Error('These injected-model SDK tests must never make paid HTTP calls.');
      },
    },
  );
}
const failsSafely = (error: unknown) => {
  assert.ok(error instanceof ApiError);
  assert.doesNotMatch(error.message, /PRIVATE_SCRIPT_MODEL_TEXT|fixture-key/);
  return true;
};

test('real Deep Agents script writer and reviewer return an attributed draft without approving or mutating the workflow', async () => {
  const source = workflow(),
    before = structuredClone(source),
    model = new ScriptedWorkflowModel(scriptResponses()),
    engine = provider(model);
  const script = await engine.script(source, new AbortController().signal, {
    minSeconds: 4,
    maxSeconds: 10,
    maxSegments: 12,
  });
  assert.equal(engine.name, 'deepagents');
  assert.equal(script.provider, 'deepagents');
  assert.equal(script.sourceRevision, source.contentRevision);
  assert.deepEqual(
    script.segments.map(({ text, seconds }) => ({ text, seconds })),
    scriptDraft().segments,
  );
  assert.equal(new Set(script.segments.map((segment) => segment.id)).size, 3);
  assert.deepEqual(source, before);
  assert.equal(source.approvals.script, null);
  assert.equal(source.approvals.scenes, null);
  assert.equal(script.agentRun?.harness, 'deepagents');
  assert.equal(script.agentRun?.model, 'gpt-6-luna');
  assert.match(script.agentRun?.contextSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(script.agentRun?.specialists, ['script_writer', 'script_reviewer']);
  assert.deepEqual(script.agentRun?.researchEvidenceIds, [evidenceId]);
  assert.deepEqual(script.agentRun?.researchContext, source.research);
  assert.match(script.agentRun?.researchNotes ?? '', /external.*structure only/);
  assert.match(script.agentRun?.reviewSummary ?? '', /attributed/);
  assert.equal(script.agentRun?.modelCalls, model.calls);
  assert.ok((script.agentRun?.toolCalls ?? 0) >= 6);
  assert.doesNotMatch(JSON.stringify(script.agentRun), /PRIVATE_SCRIPT_MODEL_TEXT/);
  assert.ok(model.received.some((messages) => JSON.stringify(messages).includes('Mori Matcha')));
  assert.ok(
    model.received.some((messages) =>
      messages.some(
        (message) =>
          message.getType() === 'tool' &&
          JSON.stringify(message.content).includes('Make time for matcha.'),
      ),
    ),
    'the reviewer reads the actual submitted draft through the SDK filesystem tool',
  );
});

test('real scene director and reviewer preserve exact script timing, segment identities and creator asset ownership', async () => {
  const source = workflowWithScript(),
    draft = sceneDraft(source);
  const before = structuredClone(source),
    model = new ScriptedWorkflowModel(
      delegation(
        'scene_director',
        'submit_scene_draft',
        draft,
        'scene_reviewer',
        'review_scene_draft',
      ),
    );
  const scenes = await provider(model).scenes(source, new AbortController().signal);
  assert.equal(scenes.provider, 'deepagents');
  assert.equal(scenes.sourceScriptId, source.script!.id);
  assert.deepEqual(
    scenes.scenes.map(({ scriptSegmentId, seconds, assetIds }) => ({
      scriptSegmentId,
      seconds,
      assetIds,
    })),
    draft.scenes.map(({ scriptSegmentId, seconds, assetIds }) => ({
      scriptSegmentId,
      seconds,
      assetIds,
    })),
  );
  assert.deepEqual(scenes.agentRun?.specialists, ['scene_director', 'scene_reviewer']);
  assert.deepEqual(scenes.agentRun?.researchEvidenceIds, [evidenceId]);
  assert.deepEqual(source, before);
  assert.equal(source.approvals.scenes, null);
});

test('a missing reviewer or an explicit rejection cannot become a completed script', async () => {
  for (const responses of [
    scriptResponses().slice(0, 4).concat([[]]),
    scriptResponses(scriptDraft(), false),
  ])
    await assert.rejects(
      provider(new ScriptedWorkflowModel(responses)).script(workflow()),
      failsSafely,
    );
});

test('a reviewer cannot accept a draft without reading its saved artifact', async () => {
  const missingRead = scriptResponses().filter(
      (calls) => !calls.some((entry) => entry.name === 'read_file'),
    ),
    pastEnd = scriptResponses().map((calls) =>
      calls.map((entry) =>
        entry.name === 'read_file' ? { ...entry, args: { ...entry.args, offset: 10000 } } : entry,
      ),
    );
  for (const responses of [missingRead, pastEnd])
    await assert.rejects(provider(new ScriptedWorkflowModel(responses)).script(workflow()), {
      code: 'PROVIDER_AGENT_INCOMPLETE',
    });
});

test('general-purpose, out-of-order reviewers and wrong-role tools cannot bypass delegation', async () => {
  const cases: ScriptedCall[][][] = [
    [
      scriptResponses()[0]!,
      call('task', {
        subagent_type: 'general-purpose',
        description: 'Write without the restricted writer.',
      }),
      [],
    ],
    [
      scriptResponses()[0]!,
      call('task', { subagent_type: 'script_reviewer', description: 'Accept without a writer.' }),
      call('review_script_draft', { accepted: true, summary: 'Skipped writer.' }),
      [],
      [],
    ],
    [
      scriptResponses()[0]!,
      scriptResponses()[1]!,
      call('review_script_draft', { accepted: true, summary: 'Writer self-approved.' }),
      [],
      [],
    ],
  ];
  for (const responses of cases)
    await assert.rejects(
      provider(new ScriptedWorkflowModel(responses)).script(workflow()),
      failsSafely,
    );
});

test('unknown research evidence and invalid script totals or provider timing never produce a draft', async () => {
  const evidence = { ...scriptDraft(), researchEvidenceIds: ['invented-evidence'] };
  const total = {
    ...scriptDraft(),
    segments: scriptDraft().segments.map((segment) => ({ ...segment, seconds: 4 })),
  };
  const timing = {
    ...scriptDraft(),
    segments: [
      { text: 'Make time for matcha.', seconds: 3 },
      { text: 'Visit Mori Matcha.', seconds: 6 },
      { text: 'Visit this weekend.', seconds: 6 },
    ],
  };
  for (const draft of [evidence, total, timing])
    await assert.rejects(
      provider(new ScriptedWorkflowModel(scriptResponses(draft))).script(workflow(), undefined, {
        minSeconds: 4,
        maxSeconds: 10,
        maxSegments: 12,
      }),
      failsSafely,
    );
});

test('parallel duplicate submissions cannot overwrite the canonical production draft', async () => {
  const responses = scriptResponses();
  responses[2] = [
    ...call('submit_script_draft', scriptDraft()),
    ...call('submit_script_draft', { ...scriptDraft(), hook: 'A competing parallel draft.' }),
  ];
  await assert.rejects(provider(new ScriptedWorkflowModel(responses)).script(workflow()), {
    code: 'PROVIDER_AGENT_INVALID_OUTPUT',
  });
});

test('a valid 300-character evidence identity and its source snapshot survive the SDK receipt', async () => {
  const source = workflow(),
    longId = 'public:' + 's'.repeat(293);
  assert.equal(longId.length, 300);
  source.research!.evidence[0]!.postId = longId;
  const draft = { ...scriptDraft(), researchEvidenceIds: [longId] };
  const script = await provider(new ScriptedWorkflowModel(scriptResponses(draft))).script(source);
  assert.deepEqual(script.agentRun?.researchEvidenceIds, [longId]);
  assert.deepEqual(script.agentRun?.researchContext, source.research);
  const snapshot = structuredClone(script.agentRun?.researchContext);
  source.research!.evidence[0]!.url = 'https://example.com/later-edited-source';
  assert.deepEqual(script.agentRun?.researchContext, snapshot);
  assert.equal(
    script.agentRun?.researchContext?.evidence[0]?.url,
    'https://example.com/public-coffee-film',
  );
});

test('invented scene segment IDs, changed seconds and foreign assets are rejected before returning scenes', async () => {
  const source = workflowWithScript();
  const original = sceneDraft(source);
  for (const change of [
    { scriptSegmentId: randomUUID() },
    { seconds: 6 },
    { assetIds: [randomUUID()] },
  ]) {
    const invalid = {
      ...original,
      scenes: original.scenes.map((scene, index) =>
        index === 0 ? { ...scene, ...change } : scene,
      ),
    };
    const model = new ScriptedWorkflowModel(
      delegation(
        'scene_director',
        'submit_scene_draft',
        invalid,
        'scene_reviewer',
        'review_scene_draft',
      ),
    );
    await assert.rejects(provider(model).scenes(source), { code: 'PROVIDER_AGENT_INVALID_OUTPUT' });
  }
});

test('shared model budget and active cancellation stop coordinator and specialists without a fallback call', async () => {
  const model = new ScriptedWorkflowModel(scriptResponses());
  await assert.rejects(provider(model, 2).script(workflow()), failsSafely);
  assert.equal(model.calls, 2);
  const controller = new AbortController(),
    canceled = new ScriptedWorkflowModel(scriptResponses());
  canceled.onCall = () => controller.abort();
  await assert.rejects(provider(canceled).script(workflow(), controller.signal), failsSafely);
  assert.ok(canceled.calls <= 1);
});
