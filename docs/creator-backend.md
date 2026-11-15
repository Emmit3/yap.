# Creator studio backend

The two creator views share one durable session and the existing versioned photo workflow. Research and interview answers are separate from approval. Selected outside films supply attributed creative techniques; their media is never downloaded or treated as a creator asset.

## Configuration

- `CREATOR_VIDEO_PROVIDER=fal` and `FAL_KEY`: choose image-first `CREATOR_VIDEO_MODEL=minimax-h3-max` or the existing `seedance-v1.5-pro` path. An unset fal model preserves the legacy Seedance default. The optional explicit `runway` selection uses `RUNWAYML_API_SECRET` and `gen4.5`. There is no automatic paid fallback.
- `OPENAI_API_KEY` also enables the shared Visual studio's direct GPT Image 2.6 generation/editing jobs. Image versions, source lineage, dedicated quotes and explicit shot selection are documented in [the keyframe guide](creator-keyframes.md).
- `OPENAI_API_KEY` and `OPENAI_MODEL=gpt-6-luna`: script/image drafting when selected, and the mandatory generated-frame reviewer. The budget profile rejects unsupported model requests; production is disabled without a supported reviewer.
- `FIRECRAWL_API_KEY`: public cinematography and X/TikTok/Instagram discovery. Missing branches are reported as unavailable, with no fabricated examples or engagement counts.
- `DEEPAGENTS_MODEL=gpt-6-luna` enables optional real SDK review of the retrieved research batch using the OpenAI key or `DEEPAGENTS_OPENAI_API_KEY` override. Missing configuration does not become a simulated agent run.
- `CREATOR_BUDGET_LIMIT_USD`: durable shared app reservation cap; defaults to USD 30 and accepts a lower positive amount, up to 30. It leaves room within a USD 35 experiment for costs outside the local ledger.

`GET /api/creator/capabilities` reports configured video, research and vision providers. Configure keys on the API process only. Default storage is `creator-sessions.json` and `creator-videos/` alongside the existing workflow data file. `createApp` accepts injected video, analyzer, reviewer and fetch implementations for isolated tests.

See [API setup and budget examples](api-setup.md). A configured capability means settings are present, not that credentials, account entitlement, live output quality, or invoices were verified.

## Public contract

Types and response validation live in `@yap/contracts/creator`. All session mutations require `expectedVersion`; operations touching the photo workflow also require `expectedWorkflowVersion`. A conflict returns 409 and never silently replays a mutation.

| Route under `/api/creator`                                    | Result                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sessions`                                              | Creates a creator session and workflow from `{input,research?,externalReferences?}`; returns `{session,workflow}`.                                |
| `GET /sessions`, `GET /sessions/:id`                          | Lists durable sessions or loads a session and workflow.                                                                                           |
| `PATCH /sessions/:id`                                         | Saves input, explicit interview answers, selected research IDs or curated external references; invalidates the clip plan and production approval. |
| `POST /sessions/:id/analyze`                                  | Starts bounded asynchronous research; returns 202 `{job,session}`.                                                                                |
| `POST /sessions/:id/prepare`                                  | Proposes a script, scenes and editable clip parameters, preserving current script edits. Never approves.                                          |
| `PATCH /sessions/:id/plan`                                    | Saves caption/clip edits and invalidates production approval.                                                                                     |
| `GET /sessions/:id/plan/review`                               | Screens the saved current plan for explicit prompt conflicts and returns its exact compiled provider prompts. No provider call or mutation.       |
| `GET /budget`                                                 | Returns `{budget}` with USD limit, reserved, charged and available cents for the shared local app scope.                                          |
| `POST /sessions/:id/quote`                                    | Requires current session/workflow versions; returns `{quote,budget}` for the exact current plan, provider and sources.                            |
| `POST /sessions/:id/approve`                                  | Requires `reviewed:true`, `costReviewed:true`, exact `planId` and `quoteId`; explicitly approves the existing workflow, plan and cost ceiling.    |
| `POST /sessions/:id/produce`                                  | Requires the exact approval and `quoteId`, plus a caller-generated `requestId` UUID. Same request ID returns the same durable job.                |
| `GET /sessions/:id/jobs`, `GET /sessions/:id/jobs/:jobId`     | Restores polling, phase, actual events and per-clip attempt/audit receipts.                                                                       |
| `DELETE /sessions/:id/jobs/:jobId`                            | Cancels locally and aborts further generation; submitted provider work may continue and be billed.                                                |
| `GET /sessions/:id/jobs/:jobId/clips/:clipId/video?attempt=1` | Serves a passed clip after verifying its saved size and SHA-256.                                                                                  |
| `GET /sessions/:id/jobs/:jobId/video?download=1`              | Serves the current approved final MP4 with range support and integrity verification. Historical approvals cannot be published through this route. |

Input supports media/text mode, natural language, public HTTPS URLs, location, platform, 15/30/60 second duration and tone. Uploaded JPEG/PNG/WebP photos continue through the existing workflow upload endpoints and their current byte/decode/version checks. Generic URLs are attribution/context, not arbitrary server fetch destinations; GitHub intake uses fixed public GitHub API endpoints. Explicit answers alone populate product facts. Retrieved claims stay attributed to their source.

Research runs independently while answers save. If the source input stays the same, completion retains later answers, chosen references and any newer plan, adding a collection-timing limitation when needed. If source input changes, the old result fails with `CREATOR_ANALYSIS_STALE`. Per-session operation locks span creator/workflow writes; research's final commit uses that same lock.

Preparation checkpoints each completed script and scene stage before another paid stage. Creator drafting receives the selected provider's timing limits. If saved timing or scene structure cannot form a valid clip plan, `CREATOR_PREPARE_REVIEW_REQUIRED` returns 409: reload the session envelope, edit the saved script in Director, and prepare again. The workflow version can advance even when no clip plan is created. Completed stages are reused; recovery does not automatically repeat paid drafting or change the creator's words.

## Real paid clip generation

### Exact quotes and durable budget

Production requires a currency-denominated quote and explicit cost approval. A quote is a **conservative ceiling**, bound to the exact plan, prompts, provider/model, source asset identity and hashes, session/workflow versions, portrait output and silent configuration. It expires after ten minutes. Changes invalidate the quote or approval. Legacy approvals without a quote cannot authorize production.

The local JSON repository atomically consumes the approved quote, creates the job and reserves its video/review cost before paid submission. The same serialized ledger also covers selected OpenAI and Firecrawl requests through the application, including legacy workflow/social calls. Reservations count against the USD 30 default cap immediately. Known model usage can settle its estimate; uncertain responses keep their ceiling reserved. Unstarted work can release its unused hold. Reserved and charged amounts are app accounting, not a reconciled provider invoice or a limit on external use of the same accounts. Optional X/xAI services are outside this selected budget profile.

The image-first fal adapter uses `minimax/h3-max/image-to-video`, with one selected source frame, 768P output, disabled prompt expansion and this app's 2–10 second shot limits. Its native audio is removed before clips are saved for review. The existing Seedance adapter uses `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` or the matching text-to-video endpoint; it requests **720p, 9:16 and no generated audio**, with clips of 4–10 seconds. Input images are normalized into a portrait JPEG without cropping away their content. The optional Runway `gen4.5` adapter supports portrait `720:1280` clips of 2–10 seconds. Provider/model selection is explicit.

H3 Max quotes reserve ten cents per generated second plus ten cents per new clip for review, using regular pricing rather than a temporary promotion. Seedance reserves five cents per generated second plus review; Runway reserves sixteen cents plus review. These deliberately conservative estimates are not represented as exact provider charges. See [image and animation configuration](creator-keyframes.md) and [pricing context](api-setup.md).

The API has one global paid production worker and at most three creator jobs in flight. It records a durable attempt and checks current approval immediately before each provider POST, after preprocessing. It saves the returned task ID before polling. Unknown POST/network outcomes are never automatically replayed. Cancellation attempts the selected provider's documented operation for a known task; running work can continue and be billed. Unconfirmed cancellation retains its hold.

Every returned clip is downloaded from the documented HTTPS artifact CDN into server-owned storage. The provider's expiring signed URLs and API key are not returned to the browser. Redirects are rejected and responses have byte/deadline bounds.

An entire clip is decoded and checked for portrait dimensions, a minimum returned size of 720 by 1280, and approved duration. This checks encoded dimensions before assembly, not whether the provider internally upscaled its output. Three sampled frames are then reviewed against its approved shot and creator image by the configured vision model, with bounded image sizes and output tokens. Reviewer/provider failures do not approve a clip and **never automatically trigger another paid generation**. Each deliberate retry requires a fresh quote and explicit cost approval. Failed/unknown attempts consume their recorded slot; the same plan allows at most two paid attempts per clip and at most 120 generated seconds. Reapproving an unchanged plan does not renew attempts. Passed clips can be reused after integrity verification.

### Prompt review and suggested shot revisions

Director's saved-prompt review shows the complete provider prompt, including the camera, lighting and fixed production instructions. It flags explicit conflicts involving sound, added lettering, multiple scenes or contradictory camera moves, as well as missing visual anchors. These are deterministic warnings, not an exhaustive interpretation of language or a guarantee of a good render. The existing combined prompt length limit remains enforced separately. Reviews identify their saved plan and workflow versions; edits require a fresh review.

Visual receipts can include categorized findings, blocking or warning severity, observed frame indices and suggested fixes. A blocking finding overrides a model's affirmative pass flag. Server-generated sample timestamps describe coverage. A reviewer may propose revised prompt, camera and lighting fields; their combined provider prompt must fit the existing limit. Oversized proposals are discarded rather than silently truncated. Older receipts remain readable.

Using a suggested revision stages those three fields for creator review. Saving uses the existing version checks and invalidates production approval; generating again still requires a new quote and explicit approval. Suggestions from an older plan cannot be staged into the current plan. The current quote reuses passed footage within the same plan; saving a changed plan does not yet provide cross-plan reuse of unchanged shots. Review the entire new quote before approving.

The three samples do not include the exact first and last frames and cannot establish continuous motion, flicker or full-film continuity. This is a prompt-screening and sampled-visual improvement loop, not a full temporal video evaluator. Human review and controlled comparisons are still required to establish accepted-shot rates.

Only passed clips are assembled. Each is padded/trimmed to its approved duration, encoded to 1080×1920 H.264/yuv420p at 24 fps, and stripped of audio. The final MP4 is decoded again to verify its measured duration, dimensions and lack of audio before saving its receipt. Frame sampling does not inspect every frame or prove factual claims; script and source accuracy still require the creator's review. The caption stays editable and posting remains manual.

Jobs, quotes, budget reservations and attempt receipts persist. On server restart, queued/running jobs become failed with an interruption explanation, and no paid request is resumed automatically. Uncertain submitted costs stay reserved. Shutdown waits for signal-aware provider cancellation and receipt cleanup. This is a bounded single-process local implementation; it does not claim distributed queue recovery or account/tenant isolation. Preserve the data file: deleting it removes the app's spending history rather than refunding provider charges.

## Verified provider documentation

Current official pages checked on November 14, 2026:

- [fal Seedance 1.5 Pro model](https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video): current silent/video-token pricing, input controls and queue schema.
- [fal queue API](https://docs.fal.ai/model-apis/model-endpoints/queue): submission, request status, response and cancellation lifecycle.
- [Runway API reference](https://docs.dev.runwayml.com/api/): current model, first-frame/text endpoints, parameters, task polling and cancellation behavior.
- [Runway API guide](https://docs.dev.runwayml.com/guides/using-the-api/): bearer authentication, version header and image data URI flow.
- [Runway output formats](https://docs.dev.runwayml.com/assets/outputs/): ephemeral signed artifact URLs and the requirement to copy generated files into application storage.
- [OpenAI gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna): supported image input and structured responses for the budget profile.

The real HTTP adapters are tested with injected provider responses. Integration tests use generated FFmpeg fixtures and an injected reviewer to exercise decoding, manual retry limits, quote invalidation, atomic budget reservations, persistence and actual MP4 assembly without incurring live generation charges. No live paid call was made during this implementation. Configured funded accounts and a controlled approved production run are still required to verify live model access, output quality and billing.
