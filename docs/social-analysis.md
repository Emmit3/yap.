# Public social research

Yap's social module turns a theme into a bounded public-evidence investigation, an explorable content/network graph, and selected creative direction for a script. The implementation is additive to the existing project and promo workflow APIs.

## Run and configure

Use the root `npm install` and `npm run dev` commands. The feature's frontend entry is the default export in `apps/web/src/social/SocialWorkspace.tsx`; the frontend owner mounts it in the connected promo UI. The baseline application shell is deliberately unchanged by the final social feature diff.

Example mode needs no credentials and makes no network requests. It explicitly labels its accounts, posts, metrics, and relationships as illustrative. Live requests never fall back to the example.

Research now starts through a pollable run so the interface can show tasks, provider calls, evidence counts, and actual research files while work proceeds. The example uses a clearly labeled, paced replay. An optional real LangChain Deep Agents coordinator delegates to three specialists through a shared virtual filesystem. See [the Deep Agents demo and setup](deepagents-demo.md). The SDK is loaded only when a live Deep Agents run is requested.

Optional API-server environment variables:

| Variable            | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `SOCIAL_DATA_FILE`  | Investigation store; defaults beside `API_DATA_FILE` |
| `FIRECRAWL_API_KEY` | Bounded public web and indexed X/Instagram discovery |
| `X_BEARER_TOKEN`    | Official X recent-search post and interaction data   |
| `XAI_API_KEY`       | Optional xAI Responses X-search citations            |
| `XAI_MODEL`         | Supported xAI tool model; current default `grok-4.7` |

A chat plugin connection is not a credential available to the running application. Keys stay on the API server. `GET /api/social/providers` reports configuration presence and source capabilities; it does not claim that a key has been authenticated or that a social account has connected successfully.

See [verified official provider references](social-provider-research.md). Direct Instagram OAuth/professional-account API integration is future work. The implemented Instagram path discovers accessible indexed public links or imports creator-supplied public evidence; it does not access private profiles or promise complete platform search.

## API

All routes below start with `/api/social`. Errors use the existing `{error:{code,message,details?}}` envelope. JSON requests retain the application's 128 KB body limit; reduce large imported samples accordingly.

| Method and route                           | Request                               | Response                                                               |
| ------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------- |
| `GET /providers`                           | None                                  | `{providers}`                                                          |
| `GET /investigations?summary=true`         | None                                  | `{investigations}` with metadata only                                  |
| `GET /investigations`                      | None                                  | Full investigations for compatibility; prefer summaries for navigation |
| `POST /investigations`                     | `SocialResearchInput`                 | `201 {investigation}`                                                  |
| `POST /investigations/import`              | `{input,dataset,publicDataOnly:true}` | `201 {investigation}`                                                  |
| `GET /investigations/:id`                  | None                                  | `{investigation}`                                                      |
| `DELETE /investigations/:id`               | None                                  | `204`                                                                  |
| `POST /investigations/:id/notes`           | `{text,kind,evidenceIds}`             | `201 {investigation}`                                                  |
| `PATCH /investigations/:id/notes/:noteId`  | Sparse note changes                   | `{investigation}`                                                      |
| `DELETE /investigations/:id/notes/:noteId` | None                                  | `{investigation}`                                                      |
| `POST /investigations/:id/query`           | `{question}`                          | `SocialQueryResponse`                                                  |
| `POST /investigations/:id/handoff`         | `{noteIds,insightIds}`                | `SocialHandoff`                                                        |

Research input contains `topic`, `audience`, unique `platforms` from `x`, `instagram`, and `web`, `mode` (`demo` or `live`), `days` (1–90), and `limit` (1–300). Defaults are seven days and 60 records. The live record budget is divided across compatible configured sources; X returns at most one recent-search page and seven days. Firecrawl dates may be unavailable, which is reported as a coverage limit.

Notes use `adopt`, `avoid`, `test`, or `context`. Evidence references must exist in the investigation. Sparse note updates preserve omitted evidence attachments. Import validates source URL/platform/author consistency and relationship endpoints, changes provenance to `import`, and states that creator-supplied counts and collection methods were not independently verified. No imported URL is fetched by the server.

## Frontend integration contract

```tsx
import SocialWorkspace from './social/SocialWorkspace';
import type { SocialHandoff, SocialInvestigation } from '@yap/contracts/social';

<SocialWorkspace
  onDirty={setDirty}
  onUseResearch={async (handoff: SocialHandoff, investigation: SocialInvestigation) => {
    setPendingResearch(handoff);
    openNewPhotoPromo();
  }}
/>;
```

`onUseResearch` runs after the creator selects notes/insights and reviews the generated handoff. `onDirty` reports unsaved note changes so the owning shell can guard navigation. The module handles investigation switching, note edits, source inspection, filters, mobile list mode, and graph navigation internally.

The handoff includes `investigationId`, `topic`, `audience`, `creativeDirection`, selected note/insight IDs, `evidence`, `sourceUrls`, and `cautions`. Evidence retains excerpts, collection/publication dates when known, provider, and content kind. A handoff fits 48 KB of serialized UTF-8 JSON. Shortening or omitted citations produce explicit cautions.

The graph distinguishes observed public relationships from derived content links. Notes float near their evidence anchors. Its list and inspector provide an alternative to panning a canvas. The first view is a list on narrow screens. Loading, source failures, empty results, unsaved note guards, and reduced motion are handled within the module.

## Research to promo workflow

Keep pending research separate from the creator's facts and photos. When creating a workflow, use its optional structured `research` field:

```ts
const input = {
  title: creatorProductName,
  input: creatorVideoRequest,
  brief: creatorSuppliedBrief,
  research: handoff,
};
// POST /api/workflows with input
```

For an existing workflow:

```ts
const refinement = {
  expectedVersion: workflow.version,
  research: handoff,
};
// POST /api/workflows/:id/refine with refinement
```

Research-only refinement increments the content revision and clears proposed scripts, scenes, and approvals. It leaves the product brief unchanged. Stale `expectedVersion` values are rejected. The existing provider context receives research as untrusted creative material, with instructions against turning external claims into product facts or copying competitor scripts.

Guided generation recognizes a small set of hook formats: question, demonstration, contrast, or direct opening. Explicit avoidance suppresses matching formats. These are transparent heuristics; arbitrary creative notes require creator review. The creator's description/benefits remain the source of spoken product claims. The model provider can interpret richer direction under the same fact/source boundary.

`/prepare` produces reviewable proposals without approval. Attach only creator-owned photos. Require the creator's explicit `/approve-all` before enqueueing `/renders`. Social collection and handoff endpoints never approve stages, render, or publish.

The legacy `/api/projects` API also accepts optional `research: SocialHandoff` on creation/update. Changing that context invalidates a prior draft, guided generation consumes its format direction, and Markdown/JSON exports retain attribution. Existing sparse PATCH behavior and creation defaults remain compatible.

## Methods, bounds, and limits

- Normalization deduplicates canonical source URLs and preserves source kinds and unknown metrics/times.
- Content analysis uses token features, a bounded inverted index, and sparse similarity candidates.
- Estimated groups combine authorship, observed links, and wording with higher weight for structural links. They describe the collected sample, not a verified complete audience map.
- Ranking combines available topical relevance, within-platform returned engagement, and observed incoming references. It is not a causal or universal virality score.
- Timeline entries use known UTC publication dates. Unknown timestamps are counted in coverage notices and excluded from dated buckets.
- Potential coordination cues require similar wording, close timing, and observed connectivity. They remain low-confidence review cues, never bot or misconduct labels.
- Retrieval is guided lexical evidence retrieval with observed neighbor context, not a connected generative RAG model. It returns actual cited excerpts or admits the sample cannot answer.
- Input bounds are 300 posts, 500 actors, and 1,500 relationships. Derived graphs contain at most 250 nodes and 600 edges; the UI draws a smaller view and retains the evidence list.
- Provider requests have a 20-second default deadline and 2 MB response bound. Two concurrent collections are permitted per router. No background monitoring runs automatically.
- X references outside the post sample preserve observed target-account links where the API returned that identity; unreturned post content is never fabricated.
- Persistence is atomic local JSON with serialized mutations, a separate social file, and corrupt-file refusal. It is intended for one API process. The default legacy full listing can be large; the shipped UI uses metadata summaries and per-ID reads.

## Verification and deferred work

Automated coverage includes provider request/response wiring with injected responses, malformed sources, timeouts and byte limits, public imports, combined analysis, unknown metadata, note CRUD/persistence, citation integrity, bounded Unicode handoffs, and actual HTTP research-to-project/workflow generation with restart and approval invalidation.

Live provider access requires configured credentials and has not been claimed as verified. No computer-use or browser automation was performed. The frontend owner's connected shell will mount and visually validate the module after social is merged into main.

Future work: official Instagram professional-account authorization, durable collection jobs, recurring monitoring, cached embeddings, generative cited answers, supported media/transcript analysis, large-network rendering, and experiments tied to actual published results. See [the full development plan](social-analysis-plan.md).
