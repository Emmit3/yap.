# Social analysis and evidence-backed creation

Implementation status: the additive social contracts, providers, API, public import, combined analysis, graph workspace, notes, retrieval, and project/workflow research handoff are implemented. Main backend snapshot `1dd6fce` is integrated into this branch. Final App/navigation and photo-promo UI mounting belong to the frontend agent after the social feature merges into main. See [current implementation and integration instructions](social-analysis.md). Live provider credentials and browser verification have not been exercised. Research objectives as a separate field, queued collection, and official Instagram account authorization remain future work.

## Product outcome

Yap should help a creator decide what to make by showing what people in their field are saying, which public posts are receiving attention, how actors and topics connect, and which creative choices the evidence supports. The research becomes a usable input to the existing brief, script, scenes, and review workflow.

The primary journey is **theme → public evidence → content and network analysis → explorable research board → selected creative decisions → script**. Research is useful on its own, but its main action is sending a reviewed set of decisions into creation.

This plan is written before implementation. The first delivery is a complete local vertical slice. Later phases describe explicit expansion work rather than features that the first delivery pretends to provide.

## Existing application and integration boundaries

- Repository: npm workspaces, TypeScript, Express, Zod runtime contracts, atomic local JSON persistence.
- Existing project routes support brief creation, guided script and shot generation, editing, and export.
- Existing workflow contracts and engine represent revisioned briefs, scripts, scenes, evidence queries, and explicit approval. Existing model and photo rendering modules must remain compatible.
- This checkout does not currently contain `apps/web`; another Yap worktree contains frontend work. Coordinate with its owner and reuse its shell, typography, palette, API client conventions, and navigation when it becomes available.
- Social transport types belong in a separate `@yap/contracts/social` entry point. Social providers, analysis, persistence, and routes belong in separate API modules.
- Social research must not require changing the meaning of existing project fields or creative approvals.
- Maintain individual commits when integrating branches. Use a regular merge commit when merging a pull request.

## Who the first version serves

A creator or small business starts with a field, theme, product idea, or question. They need concrete references and a clear recording direction, not a generic trend score. They may research before starting a project or attach findings to an existing brief.

Example investigation: “How are independent coffee brands making educational reels about home espresso?” The result should expose relevant public examples, accessible evidence, common creative patterns, community context where available, and a distinct approach the creator can review.

## First delivery scope

1. Persistent investigations with a theme, question or objective, selected platforms, and bounded research scope.
2. A clearly labeled example investigation that exercises the full product without credentials.
3. Configurable backend provider adapters for Firecrawl public discovery, official X research, and optional xAI X search where documentation supports it.
4. Importing public post evidence with explicit provenance and optional observed relationships.
5. Content analysis and connection analysis over the same dataset.
6. An interactive board with connected posts, actors, topics, and saved notes.
7. Example post inspection: excerpt, permalink, public metrics if supplied, observed relationships, creative strengths, tradeoffs, and confidence limits.
8. Filters and a chronological view of the collected sample.
9. Retrieval-based questions with evidence references and explicit missing-data responses.
10. Saved creative notes and a script handoff assembled from selected evidence.
11. Actual integration into project generation and the available creation workflow.
12. Schema, analysis, provider, persistence, route, and UI verification.

## Product principles

- Every displayed factual assertion must have an evidence source or a clear calculation over the collected sample.
- A graph edge has a named relationship and provenance. Similar wording does not establish that one account amplified another.
- Examples demonstrate behavior and remain visibly synthetic. Provider failures never silently become example data.
- Platform coverage describes the accessible sample; it never claims to represent all of X or Instagram.
- Recommendations explain observations and creative tradeoffs. They do not promise virality or identify malicious actors from weak signals.
- Research informs format, hook, structure, and audience angle. It does not turn claims made by another account into facts about the creator's product.
- Keep the main action understandable: explore evidence, save a note, use selected notes in a script.

## User experience

### Entry and investigation setup

Add Research to the app's existing navigation. The entry view lists saved investigations and offers “Research a theme” and “Explore an example.” A creation workflow may prefill theme and audience from its brief.

The research form captures:

- Theme or idea in natural language.
- A research objective, such as finding creative references, understanding a narrative, comparing communities, or evaluating amplification patterns.
- Source platforms: X, Instagram, and broader public web.
- Optional audience and date bounds.
- Collection mode: public research from configured providers, public evidence import, or labeled example.
- A visible result limit with a conservative default.

Show which integrations are configured before collecting. Explain partial availability inline. A provider that is not configured should offer a usable next step such as importing public evidence or using the example.

### Main workspace

Use the existing Yap shell. The primary surface is a research canvas, with a compact query toolbar and a collapsible inspector. A side-by-side list provides a keyboard-friendly alternative to navigating the canvas.

The canvas contains:

- Posts with short excerpts and platform labels.
- Actors with public display labels.
- Topics derived from the collected content.
- Communities derived from observed connections only when supported.
- Saved notes positioned near their referenced evidence.

Keep notes visually distinct from retrieved evidence. Stable positions avoid a graph that rearranges while someone is reading. Selection highlights immediate neighbors and opens the inspector. Pan, zoom, reset, and type filters must be usable without relying only on dragging.

On smaller screens, switch to graph/list tabs and a full-width inspector. Preserve selection and note state when switching views. All actions need keyboard focus, accessible labels, loading, empty, and error behavior. Respect reduced motion.

### Post inspector

Display the permalink, provider, retrieval timestamp, excerpt, author when supplied, publication time when supplied, and public metric values. Unknown metrics remain unknown.

Creative analysis separates:

- Observable pattern: question opening, demonstration, before/after, list structure, contrast, or call to action.
- Potential strength: what the structure may help a viewer understand.
- Tradeoff: ambiguity, crowding, evidence gap, overused angle, or production demands.
- Application: a practical change to the creator's hook or scene plan.
- Evidence limitation: text-only access, missing video/transcript, unverified timestamps, or no baseline for engagement comparison.

Do not infer visual or audio details from a caption. Do not fabricate video thumbnails, transcripts, view counts, follower counts, or account relationships.

### Saved notes and decisions

The creator can save, edit, and remove a note with a clear decision type: adopt, avoid, test, or context. Each note retains referenced post IDs and the investigation it came from.

Examples:

- Adopt: “Open with the specific espresso mistake before introducing the product.”
- Avoid: “Do not repeat the unsourced health claim in this caption.”
- Test: “Compare a direct question hook with a demonstration opening.”
- Context: “The accessible sample contains more educational captions than price-led offers.”

Notes are connected to evidence on the canvas. A decision tray shows what will be sent to script creation. Selecting a note does not immediately overwrite a script.

### Research question panel

Questions such as “Which examples explain the problem most clearly?” retrieve relevant posts, actors, topics, and notes from the current investigation. Answers include clickable evidence references and state when the sample cannot answer.

The first implementation can use deterministic retrieval and extractive answers. Label that behavior accurately. A later generative answer provider should use the same retrieval envelope and evidence validation rather than receiving an unbounded dump of scraped content.

### Script handoff

The creator selects notes, reviews the resulting creative direction, and chooses the target creation context. The handoff contains a research summary, preferred hook approach, key points, cautions, experiment ideas, and evidence citations.

For the existing project path, create a linked brief or attach a bounded research context to the selected project. Generation must consume that context explicitly. For the richer workflow path, preserve approval rules and invalidate only the affected creative artifacts when research direction changes.

Keep creator product facts separate from external inspiration. Store the source investigation and selected note IDs with the resulting brief or handoff. Record what changed so the creator can understand why a script takes a particular direction.

## Data sources and provider behavior

### Firecrawl

Use the user's configured backend API key for product requests. A connected chat plugin can help research during development but is not automatically a credential available to the running app.

Use bounded searches for the theme and source domains. Prefer structured metadata and canonical URLs. Scrape only accessible public pages when useful and supported. Preserve whether content came from a search excerpt or a retrieved page. Stop at configured limits.

Public discovery can find X and Instagram URLs without supplying comprehensive platform access, reliable engagement metrics, or a social interaction graph. If a source is blocked or unavailable, retain the discovery record and explain the limitation.

### X

Use official API search when a configured account has access. Request the documented post fields and expansions needed for authors, public metrics, references, and timestamps. Bound pagination.

Create observed edges only from explicit reply, quote, repost, or mention records. Missing referenced posts remain identifiable as outside the sample and must not be treated as fully retrieved evidence.

Do not crawl follower networks by default. A post interaction network is more directly relevant, cheaper to collect, and easier to explain.

### Instagram

Do not assume an API exposes unrestricted Instagram keyword search, all public posts, or a complete social graph. Separate public web discovery from any official professional-account integration.

The first version supports accessible public Instagram links and caption evidence returned by configured discovery or import. A later official integration can add authorized professional-account media and supported discovery features after verifying current permissions, app review, and access terms.

Never request login cookies, private messages, private accounts, or workarounds for access controls.

### Optional xAI / Grok

Verify the current Responses/tool API before coding. Use documented X search capabilities where available. Preserve returned citations and source URLs. Answers with citations are research leads; infer neither engagement metrics nor actor-to-actor edges unless the source explicitly supplies them.

Keep this adapter optional. Model choices, endpoint URLs, timeouts, and maximum tool work belong on the server. Avoid exposing provider credentials in browser settings or build-time frontend variables.

### Public evidence import

Accept a validated, bounded JSON payload of posts and explicit relationships. This supports user-provided public datasets and repeatable tests without pretending imported values were independently verified.

Validate platform URLs, text length, timestamps, nonnegative metrics, IDs, and relationship endpoints. Reject private or non-public declarations and unsupported URL schemes. Imported provenance remains visible.

## Shared data model

Use strict runtime schemas and exported TypeScript types for:

- Investigation input, persisted investigation, summary, and status.
- Provider identity, capability, configuration state, collection notices, and coverage.
- Public post with stable ID, canonical URL, platform, excerpt/text, author reference, optional publication time, retrieval time, optional metrics, and provenance.
- Actor with stable platform-scoped identity and source evidence.
- Observed relationship with source, target, type, evidence IDs, and optional timestamp.
- Derived topic, community, graph node, and graph edge.
- Creative insight with explanation, strengths, tradeoffs, suggested application, evidence IDs, and confidence limits.
- Saved note with text, decision type, evidence IDs, and timestamps.
- Timeline bucket and sample-level summary.
- Evidence query request and response.
- Script handoff request and response.

Never encode missing metrics as zero. Distinguish observed edges, semantic similarity edges, membership, and creator-authored note references in both schema and styling.

## Analysis pipeline

### Normalize and deduplicate

Canonicalize supported platform links, strip tracking parameters, scope actor IDs to platforms, and deduplicate by canonical post URL or platform post ID. Preserve meaningful text. Keep source records and derivation rules inspectable.

Use strict upper bounds for input posts, text length, edges, graph nodes, provider results, response bytes, and request duration. Do not accept a payload that expands into an unbounded graph.

### Content layer

For the first delivery, use transparent deterministic text features: tokenization, stop-word removal, term weighting, hashtags, and lightweight pattern detection. Build term indexes once per investigation.

Derive topics from repeated terms. Retrieve with query overlap and term weighting. Any later embeddings should be cached by normalized text hash and model version. Approximate nearest-neighbor indexing becomes useful only when the corpus warrants it.

Creative analysis must describe detectable structures and explain its limits. Text analysis cannot evaluate unseen visual editing or audio.

### Connectivity layer

Build sparse adjacency maps from observed public interactions. Compute degree and connected components in O(V + E). Community labels must explain the method and sample bounds; connected components are acceptable first-version groupings but should not be presented as a sophisticated audience segmentation model.

Identify actors that connect otherwise separate observed groups using bounded neighborhood calculations. Defer expensive global betweenness and large graph clustering until a real dataset justifies them.

### Combined layer

Compare topic concentration across observed groups, find thematically similar posts in different groups, and show which observed actors link relevant discussion.

A useful insight combines an actual content pattern with observed structure. When no interaction data exists, state that the connection layer is incomplete and show content relationships with separate edge styling.

Do not label an actor a bot or a campaign as coordinated based on similarity alone. Potential coordination requires multiple independent signals such as repeated text, repeated shared links, and synchronized observed timing. The first delivery may surface review signals with their underlying evidence; definitive actor classification is outside scope.

### Timeline and narrative spread

Group known publication times into stable buckets. Show volume and topic changes within the collected sample. Observed temporal edges can show an actual reply/quote/repost sequence.

An earlier similar post is not proof of an origin. Do not infer a causal spread path from chronology alone. Unknown timestamps remain in an explicit unknown bucket.

### Attention and ranking

Where public metrics exist, explain the exact ranking calculation and compare within platform. Missing metrics do not count as low performance. A sample-relative engagement rank is not proof of virality, reach, conversion, or causation.

Use “Examples with public engagement” unless sufficient evidence supports a stronger label. Any threshold must show its definition and sample size.

## Backend and persistence

Implement a social router mounted under `/api/social`, separate from the existing project routes. Use a repository with the same atomic-write and serialized-mutation discipline as project storage.

Suggested operations:

| Operation                  | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| List provider capabilities | Explain current source availability without exposing secrets |
| List investigations        | Reopen saved research                                        |
| Create investigation       | Validate scope, collect or import evidence, analyze, persist |
| Read investigation         | Return the stored evidence and derived graph                 |
| Delete investigation       | Remove its local stored research                             |
| Create/update/delete note  | Persist reviewed creative decisions                          |
| Query investigation        | Retrieve evidence and answer from the current sample         |
| Build script handoff       | Validate selected notes and return bounded creation context  |
| Apply handoff to project   | Persist research direction and use it during generation      |

Keep provider network calls outside serialized storage locks. Save only validated results. Failed collection must not silently destroy a previous successful investigation.

The first delivery uses bounded requests with explicit progress/loading behavior. Move collection to queued jobs with durable status, retries, and cancellation before adding large multi-page collection or recurring monitoring.

Expose safe, actionable provider errors. Do not return credential values, raw authorization headers, or provider response bodies that may contain secrets.

## Efficiency and compute budget

- Conservative default result count and hard maximum.
- Bounded provider requests and pagination.
- Abortable requests with explicit deadlines and maximum response size.
- Sparse graphs and indexed lookups rather than all-pairs account comparison.
- Deterministic first-pass analysis before optional model summarization.
- Limit displayed graph density; retain the evidence list as a complete accessible representation.
- Cache derived analysis per evidence revision; note changes should not trigger recollection.
- Preserve analysis methodology and version so results are reproducible.
- Document the local JSON store's single-process boundary. A future hosted deployment needs authentication, tenant isolation, transactional storage, job workers, and quota accounting.

## Privacy and evidence handling

Collect public post text, URLs, public account labels, documented public metrics, and explicit interactions needed for the investigation. Do not infer sensitive traits or build personal dossiers.

Treat retrieved text as untrusted source material. It cannot issue instructions to the assistant or provider. Bound what is passed into later model prompts.

Deleting an investigation removes its local evidence and notes. Preserve source attribution in handoffs already saved to a project, with an explicit research snapshot or reference policy. Avoid logging full collected content or secrets by default.

## Delivery phases

### Phase 1: Contract and evidence engine

Add social schemas, public evidence normalization, bounded deterministic content/network analysis, example fixtures, and meaningful regression tests. Confirm invariants for IDs, graph endpoints, optional metrics, reference validity, and bounds.

### Phase 2: Providers, storage, and API

Implement current documented provider adapters with injected fetch for tests, provider capability status, atomic research persistence, CRUD, note operations, retrieval, and handoff endpoints. Configure backend-only environment variables and document setup.

### Phase 3: Research workspace

Integrate with the existing frontend when its owner provides the shell. Implement investigation creation, saved research, graph/list exploration, inspector, filters, timeline, notes, provider states, and responsive behavior.

### Phase 4: Creation integration

Persist selected research context on the existing creation path, use it explicitly in generation, retain citations, and exercise the full research-to-script flow. Coordinate with the main/workflow agents rather than replacing their application files.

### Phase 5: Verification and integration

Run formatting, type checks, test suites, production builds, and a browser pass at desktop and narrow widths. Verify example, empty, unavailable provider, error, reload persistence, note editing, query citations, and script handoff. Integrate reviewed commits with the main worktree's owner.

### Later expansion

Durable collection jobs; recurring monitoring; official Instagram professional-account authorization; cached embeddings; model-written summaries with validated citations; larger graph rendering; stronger community algorithms; supported video/transcript analysis; temporal coordination review; experiment tracking connecting published outcomes back to creative choices.

## Parallel ownership

- Coordinator: architecture, full plan, integration, frontend shell coordination, script handoff integration, end-to-end validation.
- Analysis agent: social contracts, deterministic analysis, evidence fixtures, and related tests.
- Provider/API agent: providers, storage, social router, and related tests.
- Documentation/research agent: current official provider evidence first; then frontend workspace or independent verification after research is complete.

Agents share the checkout but own distinct files. Agree on interfaces before writing consumers. Do not concurrently modify root tooling or lockfiles. Coordinator performs dependency installation and final integration checks.

## Acceptance checklist

- A creator can choose a theme and open a saved investigation.
- An example works without credentials and remains visibly labeled.
- A configured provider can collect public evidence through a real adapter.
- Unconfigured providers report a precise available alternative.
- Post evidence retains permalinks, provenance, timestamps when known, and optional metrics.
- At least one analysis demonstrably combines content with observed connectivity.
- Similarity and observed interaction edges are visibly different.
- The graph can be explored by pointer and the same evidence can be inspected by keyboard in a list.
- Users can save and edit connected creative notes.
- Questions return relevant evidence references and admit missing data.
- Selected notes create a reviewable script direction.
- That direction influences generated scripts and retains evidence attribution.
- Research, notes, and handoffs persist across API restarts.
- Bounded inputs, timeouts, provider failures, and malformed output are tested.
- Existing project/workflow tests keep passing.
- Production build, formatting, and type checks pass.
- Main integration preserves other agents' work and commit history.
