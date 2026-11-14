# Yap Deep Agents demo

## Track outcome

Yap's research demo should demonstrate one connected task: take a creator's theme, gather bounded public evidence, combine what posts say with observed network structure, and turn reviewed findings into a cited creative direction. The proposal then enters the existing promo workflow, where the creator supplies their own product facts and reviews the script.

The Deep Agents harness earns its place by delegating specialist work, sharing bounded evidence through a virtual filesystem, and showing actual task/tool progress. A multi-agent label or an animated loading sequence alone does not establish harness use.

## Verified references

Sources were read on November 13, 2026. The supplied [Hack Princeton workshop](https://github.com/langchain-samples/hack-princeton-intro-to-deep-agents) is a Python tutorial, while Yap uses the supported JavaScript/TypeScript SDK. The workshop's first module covers planning, files, delegation, backends, middleware, and human review; its second module drives the research agent through threads and streamed UI activity. The [workshop agent source](https://github.com/langchain-samples/hack-princeton-intro-to-deep-agents/blob/main/agent.py) explicitly adds planning middleware and bounds each research worker's search use.

Use official JavaScript documentation for implementation signatures:

- [Quickstart](https://docs.langchain.com/oss/javascript/deepagents/quickstart) and [customization](https://docs.langchain.com/oss/javascript/deepagents/customization): SDK setup, models, tools, and middleware.
- [Subagents](https://docs.langchain.com/oss/javascript/deepagents/subagents): isolated specialist instructions, tool overrides, inherited models, and structured outputs.
- [Backends](https://docs.langchain.com/oss/javascript/deepagents/backends): virtual state storage, thread scope, and shared supervisor/subagent files.
- [Tools](https://docs.langchain.com/oss/javascript/deepagents/tools): custom tools with validated schemas.
- [Deep Agents event streaming](https://docs.langchain.com/oss/javascript/deepagents/event-streaming) and [LangChain event streaming](https://docs.langchain.com/oss/javascript/langchain/event-streaming): current version 3 projections for delegated tasks and tool execution.
- [Todo list UI](https://docs.langchain.com/oss/javascript/deepagents/frontend/todo-list): planning is opt-in through `todoListMiddleware`.
- [Using these docs](https://docs.langchain.com/use-these-docs): `.md` representations, documentation index, and separate conceptual/API-reference MCP endpoints. No MCP installation is required for the product demo.

## Package baseline

The current npm package metadata and published package types were inspected during research. These exact dependencies are installed in the Node 24 TypeScript API workspace:

| Package             | Pin      |
| ------------------- | -------- |
| `deepagents`        | `1.16.5` |
| `langchain`         | `1.6.6`  |
| `@langchain/core`   | `1.4.1`  |
| `@langchain/openai` | `1.8.4`  |

Keep the existing compatible Zod dependency. The selected OpenAI integration requires Node 22 or newer; Node 24 satisfies that requirement. Run the repository's normal checks before release. The harness tests use real Deep Agents planning, delegation, tools, and shared files with an injected deterministic chat model. They do not prove a live provider account or model key works.

Deep Agents 1.16.5 declares compatible peers including `langchain ^1.6.4`, `@langchain/core ^1.3.7`, `@langchain/langgraph ^1.6.1`, `@langchain/langgraph-sdk ^1.9.23`, `@langchain/langgraph-checkpoint ^1.1.5`, and `langsmith >=0.11.0 <1.0.0`. Compatible current peer versions observed were LangGraph 1.7.4, SDK 1.16.0, checkpoint 1.2.2, and LangSmith 0.12.0. OpenAI and Anthropic integrations are optional peers; this implementation explicitly chooses OpenAI and does not need Anthropic. Let the root npm lockfile record the resolved peer tree; do not create another lockfile.

Registry references: [deepagents](https://registry.npmjs.org/deepagents/1.16.5), [langchain](https://registry.npmjs.org/langchain/1.6.6), [core](https://registry.npmjs.org/@langchain%2fcore/1.4.1), [OpenAI integration](https://registry.npmjs.org/@langchain%2fopenai/1.8.4).

## Minimal SDK shape

This illustrates the verified API surface. The actual implementation must connect the bounded provider and analysis functions, apply deadlines/cancellation, and validate all final evidence references.

```ts
import { createDeepAgent, StateBackend } from 'deepagents';
import { tool, todoListMiddleware } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

const evidenceLookup = tool(async ({ query }) => lookupCollectedPublicEvidence(query), {
  name: 'lookup_public_evidence',
  description: 'Retrieve relevant records from this investigation only.',
  schema: z.object({ query: z.string().trim().min(1).max(500) }),
});

const model = new ChatOpenAI({
  model: configuration.model,
  apiKey: configuration.apiKey,
});

const agent = await createDeepAgent({
  model,
  backend: new StateBackend(),
  middleware: [todoListMiddleware()],
  tools: [evidenceLookup],
  systemPrompt: coordinatorInstructions,
  subagents: [
    {
      name: 'network_analyst',
      description: 'Compare content patterns with observed public connections.',
      systemPrompt: networkAnalysisInstructions,
      tools: [evidenceLookup],
    },
  ],
});
```

The omitted application functions and instruction variables above are explicit integration dependencies, not claims that an unconfigured search tool runs. A tool is created with `tool(function, {name, description, schema})`. Specialist specifications use `name`, `description`, `systemPrompt`, optional `tools`, and optional `model`. A supplied specialist tool list overrides inherited tools. Models may be provider-qualified strings or initialized LangChain model instances. Keep model choice configurable and provider credentials on the server. [API guidance](https://docs.langchain.com/oss/javascript/deepagents/customization), [tool contracts](https://docs.langchain.com/oss/javascript/deepagents/tools), [specialist configuration](https://docs.langchain.com/oss/javascript/deepagents/subagents).

## Real harness behavior

Use a coordinator plus three focused specialists, with distinct access and outputs:

1. **Source researcher:** collect public evidence once through the configured source adapters. Retain canonical URLs, retrieval provenance, and optional observed interaction fields. Enforce the investigation's result and request limits.
2. **Network analyst:** read the evidence artifact and run bounded deterministic content/connectivity analysis. Distinguish observed interaction edges from content similarity; report when the source sample lacks connectivity.
3. **Creative strategist:** read the evidence and analysis artifacts, identify supported strengths and tradeoffs, and propose citeable script decisions. Do not rewrite competitor claims as facts about the creator's product.

The coordinator delegates actual `task` calls, checks their outputs, and persists the validated investigation. Specialists should not repeat collection or run uncontrolled additional searches. Agent tool names must map to real implementations; public telemetry must reflect completed work rather than a timer's invented milestones.

`StateBackend` supplies graph-state virtual files, shared by the coordinator and specialists in the current thread. It supports filesystem tools without granting access to the API server's working directory. Preserve only validated research results through Yap's existing repository. A run-local filesystem does not itself establish durable cross-session memory. Cross-turn persistence requires checkpointed thread state. [Backend behavior](https://docs.langchain.com/oss/javascript/deepagents/backends).

Useful virtual artifacts include the bounded collection request, public evidence JSON, the analysis result, and the creative-direction result. Use the actual created file paths and measured metadata when displaying artifacts; do not claim files were written before their tool operation completes.

## Public activity, without private reasoning

The current JavaScript event API is:

```ts
const stream = await agent.streamEvents(input, { version: 'v3' });
for await (const call of stream.toolCalls) {
  emitPublicToolStarted(call.name);
  const output = await call.output;
  const error = await call.error;
  emitValidatedToolOutcome(call.name, output, error);
}
const finalState = await stream.output;
```

Consume required projections concurrently so a slow specialist does not hide other work. `stream.subagents` yields delegated task handles with `name`, `taskInput`, `toolCalls`, nested `subagents`, and `output`. `stream.values` provides state snapshots. These are server-side sources for a deliberately narrow public event contract. [Deep Agents events](https://docs.langchain.com/oss/javascript/deepagents/event-streaming), [tool lifecycle and concurrent consumers](https://docs.langchain.com/oss/javascript/langchain/event-streaming).

Only expose allowed fields: role, public task name, status, bounded search term, provider, result count, source references, artifact path, and timestamps. A visible plan consists of concise task titles and statuses. Do not forward raw graph state, model prompts, full tool arguments, unbounded tool outputs, or `message.reasoning`. No chain of thought is needed for the demo.

The browser uses a research-run resource, not a client-held provider connection. The agreed boundary is `POST /api/social/research-runs`, polling `GET /api/social/research-runs/:id`, cancellation through `DELETE`, and a capabilities endpoint. A completed run supplies its persisted investigation ID. Polling at the advertised interval lets the UI update agent roles, actual task progress, source counts, and files while collection runs.

Configure `DEEPAGENTS_MODEL` to a supported OpenAI model ID and set `OPENAI_API_KEY` or the research-specific `DEEPAGENTS_OPENAI_API_KEY`. Configure at least one compatible public-data provider as described in [social analysis](social-analysis.md). The live harness is disabled until its model and key are configured; the example replay needs neither.

The API loads the Deep Agents SDK only when the selected live harness runs. Capability checks, ordinary public search, and example replay do not load it. Collection is cached within a run so specialist work cannot multiply external search batches. Model and tool calls have explicit limits, alongside the provider response and timeout budgets.

`GET /api/social/research-runs/capabilities` explains execution availability. `POST /api/social/research-runs` accepts the existing research input plus `harness: 'pipeline' | 'deepagents'`, returning `202 {run}`. The run includes status, execution mode, ordered public events, five allowlisted artifact metadata records, and an eventual investigation ID. Read a created file with `GET /api/social/research-runs/:id/artifacts?path=...`; native filesystem paths are rejected. Inspectable files contain bounded source previews and interpretations, not raw model output.

The server retains at most 50 ephemeral runs for 30 minutes, accepts two active searches, caps activity at 200 events and each artifact at 64 KB, and limits a run to 120 seconds before its final atomic save. Cancellation aborts provider/model work. Once the atomic local save starts, `canCancel` becomes false and the run finishes that save rather than reporting a canceled result that was actually persisted. API shutdown aborts active research alongside existing render cleanup. Saved investigations remain durable after run telemetry expires.

## Honest replay and live execution

| Execution     | What it demonstrates                                                                                                  | Required label                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `demo_replay` | A repeatable synthetic investigation, UI activity, graph exploration, and script handoff without external credentials | Synthetic demo replay; simulated source activity |
| `pipeline`    | Actual configured provider collection and deterministic analysis, with real progress events                           | Public research pipeline                         |
| `deepagents`  | Actual LangChain Deep Agents planning/delegation, tools, virtual files, and validated investigation output            | Live Deep Agents run                             |

A replay remains useful for the first click and a backup presentation, but does not count as proof that a model or external platform API was contacted. A configured pipeline is not automatically a Deep Agents run. Provider failure must remain visible and must never silently become synthetic evidence.

The replay may animate over a few seconds so people can read the stages. Its event labels must say they are simulated. Live progress follows real events and has no manufactured completion percentage. Show partial source coverage and unknown metrics explicitly.

## Demo run-of-show

1. **Explain the problem:** content and connectivity each reveal something; Yap joins them to help a creator decide what to make.
2. **Choose a concrete theme:** use the coffee example for a predictable public explanation. Start with the labeled replay when credentials or network reliability are uncertain.
3. **Show the research cockpit:** identify the coordinator and three specialists. Point out task progress, public source counts, and actual artifact metadata. If the run is live, show the selected harness and configured sources before starting.
4. **Inspect the combined evidence:** open a public post, its strengths and cautions, and an observed connection. Compare that edge with a derived content relationship. Explain the sample's limitations.
5. **Make a decision:** save one adopt note and one caution. Select those decisions and review the cited creative direction.
6. **Use the existing promo flow:** supply the creator's own product facts, prepare a script, and show how the reviewed direction influences presentation. Preserve citations. No automatic creative approval or render is implied.
7. **Close with technical evidence:** describe the bounded tool calls, sparse deterministic analysis, specialist context separation, virtual files, and error behavior. Distinguish implemented live execution from replayed UI behavior.

For complexity, show a coordinated multi-step task with shared artifacts rather than a single model prompt. For effective harness use, demonstrate real specialist delegation and tool/file activity with bounded scope. For demo clarity, keep the final outcome visible: an explorable finding becomes an evidence-backed script decision. These are product-facing interpretations of the requested track criteria, not additional official judging rules inferred from the workshop repository.

## Delivery checks

- Example and live modes are visibly distinguishable throughout the run and resulting investigation.
- The selected harness is reflected by the actual execution result.
- Cancellation and failed providers reach an honest terminal state.
- The cockpit displays only validated public activity fields.
- Source references resolve to records within the saved investigation.
- The graph distinguishes observed and derived relationships.
- Reviewed research reaches the existing promo workflow without replacing creator-owned product facts.
- Root type checks, tests, formatting, and builds pass after package installation and integration.
