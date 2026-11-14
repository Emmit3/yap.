# Research output inside video creation

The creator's job is to make a useful video. **View analytics should open evidence and decisions within that creation workflow**, preserving the current brief, photos, script edits, and workflow identity. Research activity explains the work; the lasting output is a source-backed creative decision that the creator can review and apply.

This design was checked against the repository and current official JavaScript documentation on November 14, 2026. The API workspace pins `deepagents@1.16.5`, `langchain@1.6.6`, `@langchain/core@1.4.1`, and `@langchain/openai@1.8.4`. Items below distinguish existing behavior from recommended integration work.

## What the harness and product expose

The current Deep Agents API returns typed projections from `agent.streamEvents(input, {version: 'v3'})`. Subagent handles expose their configured names, task inputs, nested tool streams, and final outputs. General tool lifecycle, state snapshots, and final state have separate projections. These can be consumed concurrently. They do not require displaying model reasoning. [Deep Agents event streaming](https://docs.langchain.com/oss/javascript/deepagents/event-streaming), [LangChain event projections](https://docs.langchain.com/oss/javascript/langchain/event-streaming).

Yap already adapts that server-side execution into a narrower HTTP contract. The browser polls validated research-run snapshots; it does not connect directly to a LangGraph Agent Server or use `@langchain/react`. The official frontend examples are useful design patterns, not a requirement to replace the existing API/client boundary. [Official frontend architecture](https://docs.langchain.com/oss/javascript/deepagents/frontend/overview).

| Output                   | Existing implementation                                                                                                 | Recommended creator presentation                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Scope and stage progress | Six named stages: scope, collect, normalize, analyze, brief, persist                                                    | Compact stage status beside the video brief; expand for details                                                          |
| Specialist activity      | Coordinator, source researcher, network analyst, creative strategist; bounded public events                             | What each specialist is doing and whether it finished, failed, or was skipped                                            |
| Agent plan               | `todoListMiddleware()` is enabled; the adapter reports that the plan changed, but does not return the actual todo array | Label the existing UI **Research stages**. Only add a model-plan view after introducing a validated public task snapshot |
| Artifacts                | Five allowlisted previews, with actual byte counts and creation times                                                   | Human-readable evidence/connection/findings views first; raw JSON/Markdown in an expandable technical view               |
| Evidence and insights    | Persisted posts, actors, graph, topics, findings, limitations, and notes                                                | Inspect a finding, its sources, its strengths/tradeoffs, and its practical script use                                    |
| Applied direction        | A cited `SocialHandoff` can enter workflow creation or refinement                                                       | Show which reviewed decisions affect this script, alongside creator-owned product facts                                  |

The official todo pattern reads `stream.values.todos` after opting into planning middleware. Its statuses come from actual agent state. Yap currently exposes fixed pipeline stages instead of that state, so it must not claim to show the full generated plan or calculate a planner percentage from absent todos. [Todo-list pattern](https://docs.langchain.com/oss/javascript/deepagents/frontend/todo-list).

## The integrated experience

Recommended entry: the existing video workspace has a **View analytics** action. Opening it changes the workspace pane or step rather than creating another project or navigating to an unrelated app. Use the current creator brief to suggest the research theme and audience; require an explicit action before starting a provider-backed search.

1. **Frame the question.** Display the selected theme, audience, sources, time window, result limit, and execution mode. Keep creator product claims out of the external evidence corpus.
2. **Show productive progress.** While running, lead with the current public task and completed stage count. An expandable activity view can show specialist cards, provider searches, returned-record counts, and actual artifacts. Avoid a large status dashboard displacing the creator's work.
3. **Lead with the result.** On completion, show the investigation summary, available findings, coverage, and proposed decisions. Keep the previous saved research visible until the new result is available; completion must not erase unsaved creator edits.
4. **Let evidence explain the decision.** A finding opens its related posts and graph neighborhood. A source shows its permalink, provenance, excerpt, known author/date/metrics, and limitations. Unknown values remain unknown.
5. **Apply reviewed choices.** The creator saves adopt, avoid, test, or context notes, selects them, reviews the cited direction, and applies it to the current workflow. Research context guides the hook and presentation; the creator's own brief remains authoritative for business facts.

The official subagent UI separates coordinator work from specialist output and recommends scoped, collapsible views. Apply that hierarchy to the research detail pane while keeping the creative result prominent. Do not expose every internal graph node or make the raw transcript the main output. [Subagent frontend pattern](https://docs.langchain.com/oss/javascript/deepagents/frontend/subagent-streaming).

An example decision could read: “Test a specific problem-first opening; the linked sample uses that structure in multiple connected discussions.” Its source controls should reveal the actual posts and observed links behind the statement. Similar wording alone must not become a claim that an account amplified another or that a format caused high engagement.

## Files support inspection, not a separate coding interface

Existing virtual artifacts are:

- `/research/scope.json`: bounded collection request.
- `/research/sources.json`: public evidence previews and coverage.
- `/research/network.json`: deterministic connection analysis.
- `/research/insights.json`: source-backed pattern strengths and tradeoffs.
- `/research/brief.md`: proposed creative framing for review.

Present these as “Research scope,” “Sources,” “Connections,” “Findings,” and “Creative direction.” Show raw content only when requested. A file badge appears after the artifact exists; a reserved file slot must say it has not been created yet. Preview truncation must remain visible.

Yap uses a run-local `StateBackend`, not a code-execution sandbox or access to the server filesystem. Official sandbox/file-browser examples describe a different backend and extra file APIs; they do not establish that those capabilities exist in Yap. State-backed files can be shared between supervisor and specialists, but durable cross-turn storage requires the relevant checkpoint/thread setup. [Backend semantics](https://docs.langchain.com/oss/javascript/deepagents/backends), [sandbox frontend distinction](https://docs.langchain.com/oss/javascript/deepagents/frontend/sandbox).

## Live state, cancellation, and recovery

Existing runs have queued, running, completed, failed, and canceled states. Public events include role, stage, phase, timestamp, bounded message, and optional provider/query/count/artifact/evidence fields. Do not forward private reasoning, raw prompts, complete model state, or arbitrary tool output. Task completion and saved results are distinct from creative approval or rendering.

Use stage counts derived from received events. Do not animate an invented percentage or ETA. If earlier events were trimmed, say so. The direct pipeline, actual Deep Agents execution, and synthetic example replay need different persistent labels; a replay is not evidence of a live model or source call.

Cancellation is available only while `canCancel` is true. Once the final atomic save begins, show **Saving research** and disable cancellation. Do not announce that a completed save was rolled back. A disconnected browser should offer reconnection to the same run, not automatically start another provider request. If a run completed but fetching its investigation failed, offer result recovery rather than claiming that the graph is already open.

Run events and file previews are transient: at most 50 runs are retained, terminal runs expire after 30 minutes, and server restart clears the in-memory run store. Each run caps events at 200 and each artifact at 64 KiB. These are current application limits, not LangChain guarantees.

Recommended recovery order for View analytics:

1. If a linked run still exists, show its actual activity and available artifacts.
2. Open the persisted investigation using `workflow.research.investigationId`; its graph, findings, notes, and sources do not depend on the activity log still existing.
3. If the investigation was deleted or is unavailable, show the workflow's saved handoff snapshot: creative direction, cautions, and source references. Explain that the detailed graph is unavailable.
4. Offer a deliberate new investigation if the creator wants fresh evidence. Never synthesize a replacement live trace or silently substitute example data.

The current handoff already carries an investigation ID and cited snapshot. Embedding View analytics in an existing workflow, optional run linkage, and a durable structured stage/plan summary are integration recommendations, not claims that a new analytics pane has already shipped. A run ID alone is insufficient as the durable link.

## Apply without losing creative work

Applying research to an existing workflow should use its current version and the established refinement contract. Changing research context invalidates affected proposals and approvals under the existing workflow rules. The interface must explain that consequence and preserve unsaved brief, script, scene, photo-description, and note edits until the creator saves or deliberately discards them. Receiving a new research result must not force a route change or overwrite a local draft.

The final action is **Use selected decisions in this script**. Do not automatically approve the brief, approve the script, generate footage, render, or publish. Keep evidence citations attached so a creator can revisit why a particular direction was chosen.

## Verification for the integration

- View analytics opens against the same workflow and preserves local creator edits.
- New research requires an explicit start action; reopening existing analytics makes no new provider calls.
- Actual stage status, source coverage, execution mode, and artifact availability remain truthful.
- Each applied decision has valid references into its investigation or the saved handoff snapshot.
- Observed interactions and derived content relationships stay distinguishable in both graph and list views.
- Completion, disconnection, cancellation during collection, final-save locking, expired activity, and deleted investigations have usable outcomes.
- Keyboard users can inspect the same sources through the list; concise live status is announced outside any long-lived busy region; motion respects reduced-motion preferences.

Implementation references: [social contracts](../packages/contracts/src/social.ts), [research harness](../apps/api/src/social-deepagents.ts), [transient run lifecycle](../apps/api/src/social-runs.ts), [activity UI](../apps/web/src/social/ResearchActivity.tsx), [run recovery hook](../apps/web/src/social/useResearchRun.ts), [existing promo workspace](../apps/web/src/promo/PromoWorkspace.tsx).
