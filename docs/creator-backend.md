# Creator studio backend

The two creator views share one durable session and the existing versioned photo workflow. Research and interview answers are separate from approval. Selected outside films supply attributed creative techniques; their media is never downloaded or treated as a creator asset.

## Configuration

- `RUNWAYML_API_SECRET`: the real Runway video API account key. Generation is disabled without it.
- `OPENAI_API_KEY`, optionally `OPENAI_MODEL`: existing script/image drafting when selected, and the mandatory generated-frame reviewer. Production is disabled without a reviewer.
- `FIRECRAWL_API_KEY`: public cinematography and X/TikTok/Instagram discovery. Missing branches are reported as unavailable, with no fabricated examples or engagement counts.
- Existing optional Deep Agents configuration can review the retrieved research batch. Its activity is real SDK activity; missing configuration does not become a simulated agent run.

`GET /api/creator/capabilities` reports configured video, research and vision providers. Configure keys on the API process only. Default storage is `creator-sessions.json` and `creator-videos/` alongside the existing workflow data file. `createApp` accepts injected video, analyzer, reviewer and fetch implementations for isolated tests.

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
| `POST /sessions/:id/approve`                                  | Requires `reviewed:true` and the exact `planId`; explicitly approves the existing workflow and paid clip plan together.                           |
| `POST /sessions/:id/produce`                                  | Requires the exact approval plus a caller-generated `requestId` UUID. Same request ID returns the same durable job.                               |
| `GET /sessions/:id/jobs`, `GET /sessions/:id/jobs/:jobId`     | Restores polling, phase, actual events and per-clip attempt/audit receipts.                                                                       |
| `DELETE /sessions/:id/jobs/:jobId`                            | Cancels locally and aborts further generation; submitted provider work may continue and be billed.                                                |
| `GET /sessions/:id/jobs/:jobId/clips/:clipId/video?attempt=1` | Serves a passed clip after verifying its saved size and SHA-256.                                                                                  |
| `GET /sessions/:id/jobs/:jobId/video?download=1`              | Serves the current approved final MP4 with range support and integrity verification. Historical approvals cannot be published through this route. |

Input supports media/text mode, natural language, public HTTPS URLs, location, platform, 15/30/60 second duration and tone. Uploaded JPEG/PNG/WebP photos continue through the existing workflow upload endpoints and their current byte/decode/version checks. Generic URLs are attribution/context, not arbitrary server fetch destinations; GitHub intake uses fixed public GitHub API endpoints. Explicit answers alone populate product facts. Retrieved claims stay attributed to their source.

Research runs independently while answers save. If the source input stays the same, completion retains later answers, chosen references and any newer plan, adding a collection-timing limitation when needed. If source input changes, the old result fails with `CREATOR_ANALYSIS_STALE`. Per-session operation locks span creator/workflow writes; research's final commit uses that same lock.

## Real paid clip generation

### Budget integration checkpoint

The current creator baseline enforces durable per-approval attempt and generated-second limits. It does **not** yet enforce the newly requested USD 35 total application budget or a currency-denominated quote approval. Its existing correction loop can use a second attempt within the approved limit. The coordinated API hookup must add the total spend ledger, quoted-plan approval, and manual-only paid retries before enabling live provider keys. No live paid calls were made while implementing or testing this baseline.

The adapter uses Runway's current `gen4.5` task API: text-to-video or image-to-video with an uploaded creator image encoded as a normalized JPEG. The model returns portrait `720:1280` clips of 2–10 seconds. The approved plan exposes the fixed model, silent output, exact clip durations, maximum two paid attempts per clip and maximum generated seconds (twice the planned duration, at most 120 seconds). No monetary estimate is invented; provider account pricing and charges apply.

The API has one global paid production worker and at most three creator jobs in flight. It reserves a durable attempt before each provider POST and saves the returned task ID before polling. Unknown POST/network outcomes are never automatically replayed. Polling is every five seconds. Cancellation requests Runway's task deletion on an aborted known task, but cannot promise the remote generation stops or its cost is refunded.

Every returned clip is downloaded from the documented HTTPS artifact CDN into server-owned storage. The provider's expiring signed URLs and API key are not returned to the browser. Redirects are rejected and responses have byte/deadline bounds.

An entire clip is decoded and checked for portrait dimensions and approved duration. Three sampled frames are then reviewed against its approved shot and creator image by the configured vision model. A clear failure can trigger one corrective generation within the already approved attempt budget. Reviewer/provider failures do not approve a clip. Failed/unknown attempts consume their recorded slot across manual retries of the same approval; passed clips can be reused after integrity verification. A new approval is required to change a plan or its budget.

Only passed clips are assembled. Each is padded/trimmed to its approved duration, encoded to 1080×1920 H.264/yuv420p at 24 fps, and stripped of audio. The final MP4 is decoded again to verify its measured duration, dimensions and lack of audio before saving its receipt. Frame sampling does not inspect every frame or prove factual claims; script and source accuracy still require the creator's review. The caption stays editable and posting remains manual.

Jobs and attempt receipts persist. On server restart, queued/running jobs become failed with an interruption explanation, and no paid request is resumed automatically. This is a bounded single-process local implementation; it does not claim distributed queue recovery or account/tenant isolation.

## Verified provider documentation

Current official pages checked on November 14, 2026:

- [Runway API reference](https://docs.dev.runwayml.com/api/): current model, first-frame/text endpoints, parameters, task polling and cancellation behavior.
- [Runway API guide](https://docs.dev.runwayml.com/guides/using-the-api/): bearer authentication, version header and image data URI flow.
- [Runway output formats](https://docs.dev.runwayml.com/assets/outputs/): ephemeral signed artifact URLs and the requirement to copy generated files into application storage.

The implementation does not use retired Sora or Gemini Veo preview endpoints. The real HTTP adapter is tested with injected provider responses; integration tests use a generated FFmpeg fixture and an injected reviewer to exercise decoding, correction budgets, persistence and actual MP4 assembly without incurring live generation charges. A configured paid account is required to verify live model quality and billing.
