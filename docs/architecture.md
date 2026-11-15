# Architecture

```mermaid
flowchart LR
  Inputs[Business photos and an idea] --> API[Workflow HTTP interface]
  Research[Public social research] --> Context[Attributed creative context]
  Context --> API
  API --> Engine[Refinement and verification]
  Engine --> Provider[Deep Agents drafting or explicit guided/OpenAI adapter]
  Engine --> Review[Creator review and approval]
  Review --> Queue[Durable render receipts and bounded queue]
  Queue --> Renderer[Sharp and FFmpeg]
  Renderer --> Output[Vertical MP4 and caption]
  API --> Store[Versioned workflow repository]
  Store --> Disk[JSON state and scoped media files]
  Contracts[Shared contracts] -.-> API
```

## Boundaries

`apps/web` owns presentation and transient form state. It validates input for fast feedback and validates API responses at the network boundary. Persistent state comes from the API. Export and generation actions report actual server outcomes.

`apps/api` owns authoritative validation, project lifecycle rules, generation, and persistence. The HTTP application is separate from the listening process so integration tests can run on temporary ports with isolated storage.

`packages/contracts` owns the transport vocabulary. Both applications consume it without importing each other's implementation. It exports runtime Zod schemas and TypeScript types; build it before starting either application.

The additive `@yap/contracts/workflow` and `@yap/contracts/render` exports keep the new promo flow separate from the original project schemas. `/api/projects` remains compatible. The frontend session can integrate the new interface without importing backend source; [the integration guide](promo-backend.md) contains the exact flow and fetch examples.

## State and storage

A project stores a creator's brief and an optional generated draft. Drafts include an editable script and timed shots, plus server owned generation metadata. Changing the brief invalidates generated material to avoid presenting an old plan as current. Ready state requires a draft.

A promo workflow adds a conversation, incomplete brief, uploaded photos, questions, script segments, scenes, and approvals. Every mutation carries `expectedVersion`. Slow model calls happen outside the write queue, followed by an atomic version comparison; a concurrent edit wins rather than being overwritten by an older model response. The latest 50 full workflow snapshots are retained for inspection.

Content changes advance `contentRevision` and clear downstream material and approvals. A script points to its source content revision; scenes point to an immutable script ID. Editing either creates a new artifact ID. An approval refers to the exact content revision or artifact ID, so an older approval cannot authorize changed material.

The initial storage adapter uses an atomic JSON file and serialized mutations inside one API process. It needs a persistent writable disk. It does not coordinate multiple server replicas. Replace the repository adapter with a transactional database before horizontal scaling or shared user accounts; preserve the HTTP contract when doing so.

## Generation boundary

The workflow provider defaults to `WORKFLOW_PROVIDER=deepagents`: actual LangChain Deep Agents script and scene drafting. A coordinator delegates a writer/director, then a separate reviewer that must read the saved draft. Each operation permits at most 16 model calls and 32 tool calls, with a default 90-second deadline. Strict tools validate timing, source IDs and creator asset ownership; protected canonical artifacts retain the source, draft and review. Agent review does not grant creator approval.

Explicit `guided` mode uses offline templates without a key. The direct `openai` Responses adapter remains available for strict structured output and supplied image inputs; Deep Agents also reuses it for refinement and queries. SDK script/scene specialists use saved creator descriptions and attributed research, not claimed image observations. Provider secrets stay on the backend. Requests and responses are bounded, provider failures have explicit errors, and disconnected requests cancel provider work. Tests exercise real SDK graphs with deterministic models and mocked transport.

Original generated script/scene artifacts retain server-owned `agentRun` receipts with model, source-context hash, actual call counts, specialists, cited research decisions and review summary. Optional `researchContext` snapshots preserve the exact drafting handoff and its source IDs/URLs while leaving the creator brief and existing analytics selection distinct. Later research changes do not erase that original provenance.

The main product path uses `/prepare` to propose both script and scenes, followed by one explicit `/approve-all`. Detailed stage generation and approval endpoints support closer review. Structural verification checks completeness, duration totals, segment coverage, current source revisions, and valid photo references. Review warnings identify defaults, user supplied claims, and uncertain factual content. Passing structural checks is not factual verification or automatic creator approval.

## Public research

`/api/social` owns public collection/import, deterministic content and observed-network analysis, notes, queries, and cited handoffs through `@yap/contracts/social`. Investigations persist in a separate atomic JSON repository. Pollable research runs hold temporary activity and artifact previews: two searches can be active across legacy collection requests and runs, at most 50 runs are retained, and terminal runs expire after 30 minutes. Each run caps activity at 200 events and each artifact at 64 KiB, with a default 120-second deadline before the final atomic save.

Execution modes describe actual work. `demo_replay` uses synthetic evidence and labeled simulated activity without external calls. `pipeline` uses configured public-data providers and deterministic analysis. `deepagents` adds real planning, delegation, shared virtual files and model-authored creative synthesis. Model access defaults to `gpt-6-luna` and uses `DEEPAGENTS_OPENAI_API_KEY` or `OPENAI_API_KEY`; credential presence does not prove live access. SDK modules load only for their selected operations. Failed configured agent runs do not silently become pipeline success or replay data.

The Deep Agents coordinator may delegate only to `source_researcher`, `network_analyst`, and `creative_strategist`. All share one cached collection batch, deadline, and model/tool-call budgets (24 model calls by default and 48 tool calls). A run-local `StateBackend` provides virtual files rather than access to the server filesystem or durable cross-session memory. The HTTP boundary exposes only five allowlisted artifact previews and validated public activity, excluding raw model state, prompts, and private reasoning.

Source, network and baseline insight artifacts remain deterministic. The creative specialist submits its own bounded summary and adopt/avoid/test decisions, citing only IDs in the collected evidence. The canonical brief places this attributed model synthesis before the baseline. Unknown IDs, unsupported empty decisions, oversized briefs and conflicting submissions fail; an empty evidence batch supports an explicit limitation. Creator research accepts validated public GitHub evidence as well as Firecrawl results, and its optional `execution` metadata reports completed SDK or pipeline work. These proposals remain creative context, not product facts or factual certification.

Shutdown rejects new searches, aborts legacy collections and pollable runs, and waits for tracked completion alongside render cleanup. Cancellation before the commit boundary prevents persistence. Once the final atomic save starts, cancellation becomes unavailable and shutdown waits for its actual outcome.

Selected research enters a workflow as attributed creative context, separate from creator-supplied business facts and photos. Changing that context invalidates downstream proposals and approvals. A handoff never approves content or starts rendering; the creator still reviews the proposal and explicitly approves it. See [social analysis](social-analysis.md) and [Deep Agents execution](deepagents-demo.md) for detailed interfaces and configuration.

## Photos and rendering

Photos are uploaded as binary PNG, JPEG, or WebP, decoded and bounded with Sharp, and stored under server-issued workflow and asset IDs. Client filenames never become filesystem paths. Photo bytes and hashes are checked before use; no arbitrary external image URLs are fetched. Model image understanding is only available through the configured OpenAI adapter; guided preparation does not pretend to recognize photo contents.

An approved promo is pinned to a workflow version and scene artifact. A bounded queue runs one FFmpeg job at a time, outside the JSON mutation queue. The renderer composes the actual photos, brand/title text, scene text, and final action into 1080×1920 H264/yuv420p video at 24 fps, with exact scene duration and fast-start metadata. The result is silent; no stock audio, invented footage, voiceover, or social publishing is implied.

Render receipts persist `queued`, `running`, `succeeded`, or `failed` state. The queue checks current approval and source identity before and after rendering. Content changes during a render cause a truthful failure rather than presenting stale material as current. Photo deletion is rejected while a render uses the workflow. Download and publish-kit endpoints verify the completed file's size and SHA256, and video responses support HTTP ranges for preview.

Private intermediate frames live in a verified, job-scoped directory beside the output. Normal completion and cancellation remove it. On restart, interrupted receipts become failed and known intermediate/output paths are cleaned. A crashed job is not silently resumed or reported successful. The publish kit provides a current downloadable MP4 and caption for manual posting.

## Deployment

Build from the root so the shared runtime package is emitted before consumers. The web build is static. The API is a separate Node process and must retain its shared package runtime dependency. Set a frontend API base URL and backend allowed origin for separate origins, or configure an external reverse proxy to route `/api` to the API.

Loopback binding and no authentication are deliberate local development defaults. This first slice does not implement user identity or tenant isolation. Do not treat changing CORS as adding access control.

For hosted business accounts, add identity and tenant checks at the HTTP/repository interface, move metadata to a transactional database, move media to object storage, and run render workers behind a durable distributed queue. The current JSON/one-process adapter deliberately does not claim to provide those deployment capabilities.
