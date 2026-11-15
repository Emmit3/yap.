# Creator studio backend

The two creator views share one durable session and the existing versioned photo workflow. Research and interview answers are separate from approval. Selected outside films supply attributed creative techniques; their media is never downloaded or treated as a creator asset.

## Configuration

- `CREATOR_VIDEO_PROVIDER=fal`, `CREATOR_VIDEO_MODEL=seedance-2.5` and `FAL_KEY`: select supported Seedance 2.5 generation, also the default when the provider setting is omitted. Per-shot profiles select portrait or landscape 720p dimensions, with optional supplied photos or explicitly selected storyboard frames as starting images. Seedance 1.5 Pro remains retired and refuses new generation before submission. No automatic paid fallback or Runway call occurs.
- `OPENAI_API_KEY` and `OPENAI_MODEL=gpt-6-luna`: optional script interpretation and the mandatory generated-frame reviewer. The same server key can enable separately approved storyboard images and reference-sample analysis. Image generation and narration use their own pinned model profiles; changing `OPENAI_MODEL` does not change them. Unsupported paid requests are rejected.
- `FIRECRAWL_API_KEY`: public cinematography and X/TikTok/Instagram discovery. Missing branches are reported as unavailable, with no fabricated examples or engagement counts.
- `DEEPAGENTS_MODEL=gpt-6-luna` enables optional real SDK review of the retrieved research batch using the OpenAI key or `DEEPAGENTS_OPENAI_API_KEY` override. Missing configuration does not become a simulated agent run.
- `CREATOR_BUDGET_LIMIT_USD`: durable shared app reservation cap; defaults to USD 30 and accepts a lower positive amount, up to 30. It leaves room within a USD 35 experiment for costs outside the local ledger.

`GET /api/creator/capabilities` reports configuration and available per-shot `videoProfiles`, including retirement/unavailability reasons. API commands load optional root `.env`, then `apps/api/.env`, with process environment values taking precedence. Default storage is `creator-sessions.json` and `creator-videos/` beside the existing workflow data file. `createApp` accepts injected video registries, analyzer, reviewer and fetch implementations for isolated tests.

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

Production requires a currency-denominated quote and explicit cost approval. A quote is a **conservative ceiling**, bound to the exact plan, per-shot provider/model/profile, prompts, source asset identity/hashes, selected delivery profile, saved brand snapshot, soundtrack/subtitle choices and session/workflow versions. It expires after ten minutes. Changes invalidate the quote or approval. Legacy approvals without a quote cannot authorize production.

The local JSON repository atomically consumes the approved quote, creates the job and reserves its video/review cost before paid submission. The same serialized ledger also covers selected OpenAI and Firecrawl requests through the application, including legacy workflow/social calls. Reservations count against the USD 30 default cap immediately. Known model usage can settle its estimate; uncertain responses keep their ceiling reserved. Unstarted work can release its unused hold. Reserved and charged amounts are app accounting, not a reconciled provider invoice or a limit on external use of the same accounts. Optional X/xAI services are outside this selected budget profile.

The supported fal profiles use `seedance-2.5` with Yap's bounded integer duration subset of 4–10 seconds. `fal-seedance2.5-portrait` produces native 720×1280; `fal-seedance2.5-landscape` produces native 1280×720. Optional `clip.videoProfileId` chooses the profile explicitly; omitted choices use the current default, whose identity and price are bound into the new quote. An uploaded creator image or explicitly selected verified storyboard frame switches to image-to-video; no image uses text-to-video. Image inputs are contained and padded to the exact native canvas, encoded as a bounded JPEG data URI, and submitted with `aspect_ratio:auto`. Text-to-video uses explicit `9:16` or `16:9`. Both request 720p, H.264, standard bitrate, no draft and no generated audio.

The historical fal Seedance 1.5 model was [removed on November 11, 2026](https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video). The adapter reports it as retired and rejects new generation/quotes before any provider POST. Existing task cancellation remains a historical operation; no replacement provider is automatically selected.

Each Seedance 2.5 shot reserves fifty cents per generated second, plus ten cents per new clip for sampled-frame review. Per-shot quote items and receipts retain provider/model/profile/native-dimension identity. These conservative app ceilings are not exact provider charges; see [pricing context](api-setup.md).

The API has one global paid production worker and at most three creator jobs in flight. It records a durable attempt and checks current approval immediately before each provider POST, after preprocessing. It saves the returned task ID before polling. Unknown POST/network outcomes are never automatically replayed. Cancellation attempts the selected provider's documented operation for a known task; running work can continue and be billed. Unconfirmed cancellation retains its hold.

The adapter submits once to `https://queue.fal.run/bytedance/seedance-2.5/text-to-video` or `/image-to-video`, with `Authorization: Key` and the string duration required by the current OpenAPI schema. It stores a versioned `fal:seedance-2.5:<uuid>` receipt before polling fixed owner/app request paths. Response-provided routing URLs are ignored; cancellation uses the fixed request path with PUT.

Every returned clip is downloaded from the documented HTTPS artifact CDN into server-owned storage. The provider's expiring signed URLs and API key are not returned to the browser. Downloads allow only `fal.media` and its subdomains, or the documented `storage.googleapis.com/falserverless/` bucket prefix. Redirects are rejected; JSON responses are limited to 256 KiB and MP4 downloads to 100 MiB, within the generation deadline.

An entire clip is decoded and checked for its approved duration and aspect ratio; an explicit profile must also match its exact native dimensions. Three sampled frames are then reviewed against the approved shot and selected source image, with bounded image sizes and output tokens. Reviewer/provider failures do not approve a clip and **never automatically trigger another paid generation**. Each deliberate retry requires a fresh quote and approval. Failed/unknown attempts consume their recorded slot; the same plan permits at most two paid attempts per clip and 120 generated seconds. Reapproving an unchanged plan does not renew attempts. Passed clips can be reused after integrity verification.

Only passed clips are assembled. Approved `outputProfileId` choices are `portrait-720` (720×1280), `landscape-720` (1280×720) and `portrait-1080` (1080×1920, resized from 720p). Historical omitted choices retain portrait 1080p delivery. Assembly pads/trims clips to approved duration, removes generated clip audio and encodes H.264/yuv420p at 24 fps. It adds the approved soundtrack, any brand snapshot and subtitles, then fully decodes the result. The saved output records dimensions, profile and whether resizing/cropping was required; changing delivery size does not recover source detail. Frame sampling does not inspect every frame or establish product facts. The social caption remains separate and posting is manual.

## Narration and music

The assembled film can carry a soundtrack chosen in the plan's `audio` setting: `voice` (an OpenAI built-in voice, or `null`) and `musicTrackId` (a bundled track, or `null`). `hasAudio` is true when either is set. New plans default to the `marin` voice when `OPENAI_API_KEY` is configured, and to a music track matched to the brief's tone. `PATCH /sessions/:id/plan` accepts `audio`; `GET /capabilities` lists the available voices and tracks; `GET /music/:trackId` serves a preview.

- **Narration** reads each script segment that has clips, one `gpt-4o-mini-tts` request per segment to `POST /v1/audio/speech`, in WAV. It is recorded **before any clip is generated**, so a rejected key or a script too long to fit stops production before the costly step. Each line starts with its scenes; a line that runs long delays the next rather than overlapping it, and speech is sped up by at most 25% when needed. A script above about 2.8 spoken words per second is rejected when the quote is requested. Every clip of one spoken line must play back to back: a plan whose clips return to an earlier line (A, B, A) is rejected with `CREATOR_VOICEOVER_ORDER` when narration is on, and a newly prepared plan with such scenes starts without a voice. Silent and music-only plans keep any clip order.
- **Pricing** is an app ceiling of USD 0.10 per narrated segment, shown as the quote's `audioCents` and held as one `audio` reservation at production start. The provider returns no usage for speech, so the hold is kept in full once a line was sent. Narration counts as started at the last step before the first request leaves, after the final check that the approved plan is unchanged; the hold is released when no request was sent or the first request was definitely rejected. OpenAI lists the model at USD 0.60 per million text input tokens and USD 12 per million audio output tokens and publishes no per-minute figure, so this ceiling is an estimate, not an invoice.
- **Music** comes from `apps/api/assets/music`. Each track is CC0, recorded with its source page, license evidence and SHA-256 in `credits.json`, and verified against that manifest at startup. Bundled music costs nothing.
- **Mixing** uses FFmpeg: speech is normalized to about -16 LUFS, music sits lower and is ducked further while the voice speaks, then both are encoded as AAC 48 kHz stereo beside the untouched video stream. Verification requires exactly one such audio stream when sound was approved, and none otherwise.

**Deprecation:** OpenAI has scheduled every model on `/v1/audio/speech`, including `gpt-4o-mini-tts`, to shut down on **January 6, 2027**. Its named replacement, `gpt-realtime-2.1-mini`, runs only on the Realtime API. Narration must be moved to that transport before then. See [the deprecations page](https://developers.openai.com/api/docs/deprecations).

Jobs, quotes, budget reservations and attempt receipts persist. On server restart, queued/running jobs become failed with an interruption explanation, and no paid request is resumed automatically. Uncertain submitted costs stay reserved. Shutdown waits for signal-aware provider cancellation and receipt cleanup. This is a bounded single-process local implementation; it does not claim distributed queue recovery or account/tenant isolation. Preserve the data file: deleting it removes the app's spending history rather than refunding provider charges.

## Burned-in subtitles

New prepared plans enable the free `subtitlesEnabled` option. An explicit saved choice is retained on preparation; historical plans with the field omitted stay off until prepared again or explicitly changed. Plan PATCH accepts an optional boolean and preserves omission on unrelated saves. The choice and approved subtitle source text bind into the quote fingerprint and require a new approval when changed. Quotes expose the optional choice without adding a provider, price or reservation.

Subtitles use the approved script segments mapped to the actual ordered clips, independently of the social caption. Without narration, adjacent clips of one segment share their combined scene window; silent and music-only clip orders remain supported. With narration, each line starts at the final audio placement and ends after its trimmed PCM duration divided by its applied tempo. Phrase splits inside those measured windows are derived timing, not word alignment. Both SRT and burn-in use the same centisecond-rounded cue windows.

A versioned private snapshot records plan, workflow and script identity, exact source text, windows and display cues inside the production job directory. Text wraps to at most two bounded lines per cue with minimum display time and reading-rate checks. Copy that cannot fit fails with `CREATOR_SUBTITLES_TOO_DENSE` and asks the creator to shorten it, allow more time or turn subtitles off. FFmpeg burns a server-generated ASS file with escaped literal text and safe margins for the selected delivery size. An applied brand snapshot supplies its font/colours; branding is rendered before subtitle burn-in so an opaque end card does not cover the final cues. Audio is preserved. Unsupported glyphs fail with an editable recovery message.

Successful jobs optionally include `output.subtitles` containing format, bytes, SHA-256, cue count and `timingSource` (`narration` or `scene`), without a private path. `GET /api/creator/sessions/:id/jobs/:jobId/subtitles.srt` downloads that saved UTF-8 SRT separately from the MP4 and social caption. The route checks the same session, current approval and workflow rules as video, plus successful status, artifact presence, byte bound and receipt hash. Changed or missing files fail integrity checks; failed/canceled jobs and historical jobs without a subtitle receipt have no completed subtitle export. Older artifacts are never rebuilt from a newer script.

Automated verification uses synthetic tones and local FFmpeg fixtures, including actual Unicode glyph frames, literal markup, Windows paths, post-trim/tempo timing, portrait margins, full video/audio decoding, disabled mode, sparse historical saves and guarded/tampered downloads. It does not claim a live TTS quality or word-alignment test.

## Brand snapshots and free timeline edits

[Workspace brand settings](creator-brand-edit.md) store versioned colours, font choices, an optional validated logo and a timed end card. The creator explicitly applies a verified `brandSnapshot` to the film plan; saving it invalidates earlier approval and binds its exact bytes/settings into the next quote. Editing workspace settings does not silently restyle already approved films. These settings belong to one local workspace, not an account or tenant.

Free postproduction edits are separate versioned records referencing an authorized finished job and its immutable hash/clip windows. Trims, reordering, cut/dissolve transitions and text layers do not mutate generation receipts, buy another clip or renew retry limits. Saving uses optimistic versions; rendering requires explicit review of the current edit. Preview/download verifies both the current edit receipt and access to its base film.

The editor slices the already assembled film, so existing audio and burned captions move with each slice. A manual trim can cut a spoken word or caption; there is no automatic word-aware realignment. The original generation SRT still describes the original film and is not recomputed/exported as subtitles for the edited timeline. An edited end card intentionally replaces the picture in its selected final interval.

## Storyboard and reference assets

[Storyboard generation](creator-reference-assets.md) creates one medium 1024×1536 PNG using the app's fixed `gpt-image-2-2026-04-21` profile. Its separate ten-cent ceiling quote binds prompt, purpose, current creation/workflow versions, settings and optional parent-frame hash. Generation requires explicit prompt/cost approval and a durable request ID, permits only two manual attempts for the exact versioned input and never replays interrupted work. The paid gate validates the exact payload before transport. Completed images retain generated provenance and verified byte/hash/decode receipts.

`clip.storyboardFrameId` selects a generated keyframe only through an explicit creator action. Saving the plan records the verified source hash; production checks it again. It is an alternative to the shot's supplied-photo source, not a creator fact. Parent IDs record lineage only: this initial image endpoint generates from text and does not send a parent image to an editing API.

Reference analysis imports up to 64 KB of supplied VTT/SRT/timed plain cues plus an attributed HTTPS source URL. It never fetches that URL. Up to eight timestamped uploaded stills are bounded and normalized separately from creator media. Manual notes remain labeled as such. Optional sampled-scene analysis needs a separate fifty-cent cost review, exact source hash and request identity; the final source check runs after reservation and before provider transport. Results retain model/time/sample provenance and limitations; changed sources invalidate old AI observations. Selected techniques remain external creative context and cannot become facts about the creator.

See [the reference asset API](creator-reference-assets.md#api-surface) and [brand/edit routes](creator-brand-edit.md) for endpoint details. Storage and shutdown retain the existing bounded, single-process local-service boundary.

## Verification and deployment boundary

Shared fields are optional so historical records remain readable without fabricated settings/outputs. New persisted fields and the image budget category are not readable by older strict-schema binaries. Deploy the current API/contracts together and preserve spending data before any version-aware downgrade; never discard a ledger to regain budget.

The [Mori Drinks seed and presenter path](demo-presenter.md) supply a reusable fictional starting point. Actual local FFmpeg checks and two offline-speech/photo rehearsals do not establish a live funded video/image/voice account, paid output quality or provider invoices. The real-provider Phase 0 and D4 acceptance in issue #6 still require usable access, exact approved runs and recorded cost/output review. No accounts, tenant isolation or automatic publishing are implied by these media tools.

## Verified provider documentation

Implementation references (video retirement/pricing and image-generation costs rechecked on November 15, 2026):

- [fal Seedance 1.5 Pro model](https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video): retirement notice; new API requests are unsupported.
- [fal Seedance 2.5 text-to-video API](https://fal.ai/models/bytedance/seedance-2.5/text-to-video/api) and [image-to-video API](https://fal.ai/models/bytedance/seedance-2.5/image-to-video/api): current input/output fields, duration strings, image-conditioned aspect ratio and file inputs.
- [fal Seedance 2.5 access and pricing](https://fal.ai/learn/tools/how-to-access-seedance-2-5-on-fal): token-based pricing; disabling generated audio does not reduce the video charge.
- [fal queue guide](https://fal.ai/docs/documentation/model-apis/inference/queue): authentication, owner/app request paths, status, result retrieval and cancellation.
- [OpenAI gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna): image input and structured responses for the bounded text/vision profile.
- [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation): GPT Image 2 output costs and image generation behavior; Yap pins its supported profile instead of silently upgrading models.

The real HTTP adapters are tested with injected provider responses. Integration tests use generated FFmpeg fixtures and an injected reviewer to exercise decoding, manual retry limits, quote invalidation, atomic budget reservations, persistence and actual MP4 assembly without incurring live generation charges. No live paid call was made during this implementation. Configured funded accounts and a controlled approved production run are still required to verify live model access, output quality and billing.
