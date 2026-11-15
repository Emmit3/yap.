# Storyboard frames and attributed reference analysis

The creator studio keeps generated storyboard frames, imported reference evidence and creator supplied facts distinct. These features use the existing local workspace and spending controls. They do not connect a ChatGPT subscription or a Higgsfield website plan to the product API.

## Generate and choose a frame

Storyboard generation uses OpenAI's Images API with a fixed profile: `gpt-image-2-2026-04-21`, one medium quality 1024 × 1536 PNG. The prompt is limited to 2000 UTF-8 bytes. A quote binds the prompt hash, purpose, session/workflow versions, model, output settings and optional earlier frame identity. It expires after ten minutes.

The creator reviews the exact prompt and separately approves a maximum of USD 0.10 before generation. The configured adapter receives only the application paid gate's fetch implementation. The gate reserves before transport and settles a known rejection or supported usage; an uncertain submitted outcome retains its conservative hold. No generation, fallback or retry starts automatically.

The app ceiling is conservative accounting, not a provider invoice. The official guide lists medium portrait output for GPT Image 2 at about USD 0.041 before text input. Text input is USD 5 per million tokens and image output is USD 30 per million tokens. The bounded text only prompt and fixed output fit beneath the ten cent reservation with headroom. Pricing was checked on November 15, 2026; changing models, output settings or billing policy requires an explicit price model and gate update.

Requests use durable idempotency IDs. Replaying the same ID returns its saved job; a different quote cannot reuse that ID. Failed or interrupted requests require a new quote and deliberate approval. The same exact versioned image input permits at most two attempts. Restarted running jobs become interrupted failures and never resume paid work automatically.

A completed output must fully decode as a single PNG with the approved dimensions and fit the byte/pixel limits. Its server owned size, SHA-256 and generated API provenance are saved. Downloads and explicit frame selection verify those bytes. The frame becomes a production reference only when the creator chooses **Use this frame**; choosing it does not approve the resulting film.

An earlier frame ID records lineage and its verified hash. This initial endpoint generates from text; it does not send that earlier image to an editing endpoint or promise visual continuity. The actual PNG is 1024 × 1536, not a claimed 4K image. ChatGPT's built-in image tool billing is separate.

## Import a reference without fetching its URL

Reference imports accept a public HTTPS attribution page and up to 64 KB of supplied WebVTT, SRT or timed plain text. Every cue needs explicit start/end timestamps and text. Untimed prose is rejected instead of assigning invented timing. Cues remain chronological, are limited to 1000 entries and cannot exceed two hours. VTT caption markup is treated as text; no source page, video, credentials, cookies or redirect is fetched.

The creator can add up to eight uploaded sample frames with explicit timestamps. Each still is decoded, bounded and normalized into a server owned JPEG of at most 512 KiB. The saved frame hash and transcript hash identify the analysis snapshot. Uploaded frames remain external reference evidence, never creator supplied product photos.

Manual observations are labeled as the creator's notes. Importing a transcript or writing a note does not claim transcription, AI analysis or verification of the source's statements.

## Analyze only the approved samples

Configured visual analysis receives the uploaded samples and supplied cues through the existing bounded Responses API paid gate. The creator reviews the source snapshot and approves a maximum of USD 0.50. The approval binds the reference version and source hash. Exact request IDs are idempotent and only two deliberate attempts are permitted for one source snapshot. Missing visual configuration leaves imports and manual notes usable.

The saved result includes the actual configured model, analysis timestamp, frame-specific observations, source snapshot and explicit limitations. Returned observations must refer to one of the approved uploaded frames. Adding a frame or manual note changes the snapshot and invalidates earlier AI observations. Results from an in-flight analysis are discarded when its source changes; already submitted provider work may still be billed.

Only supplied moments are inspected. The result does not claim complete video understanding, automatic transcript retrieval, exact spoken word alignment or independent fact checking. The transcript remains attributed supplied content, and sampled frames leave unsampled moments unknown. Selected observations may inform creative direction while retaining attribution; they do not become facts about the creator's business.

## API surface

Under `/api/creator/sessions/:id`:

| Route                                                        | Behavior                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `GET /images`                                                | Saved image jobs and configuration state.                                           |
| `POST /images/quote`                                         | Quotes a bounded prompt and current versions.                                       |
| `POST /images/generate`                                      | Requires quote, exact review/cost approval and idempotency ID.                      |
| `GET /images/:frameId/image`                                 | Verifies and serves a completed PNG.                                                |
| `GET /reference-analysis`                                    | Lists attributed reference records.                                                 |
| `POST /reference-analysis`                                   | Imports a supplied timed transcript.                                                |
| `POST /reference-analysis/:referenceId/frames`               | Uploads a timestamped still with the expected record version.                       |
| `GET /reference-analysis/:referenceId/frames/:frameId/image` | Verifies and serves a normalized sample.                                            |
| `POST /reference-analysis/:referenceId/observations`         | Saves a labeled manual observation.                                                 |
| `POST /reference-analysis/:referenceId/analyze`              | Requires exact source hash, version, request ID and the fixed analysis cost review. |

Storage is bounded, atomic and scoped by creation. It shares the repository's single-process local deployment boundary; hosted accounts and tenant isolation remain separate work.

## Verification boundary and sources

Tests inject providers and check persisted idempotency, exact approval/version gates, attempt limits, malformed/tampered output, timestamp parsing, frame bounds, attribution and analysis invalidation. They do not prove a live image or vision account is funded or that a paid output meets the creator's quality expectations. No paid call was made while implementing these modules.

Official sources: [image generation guide](https://developers.openai.com/api/docs/guides/image-generation), [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2), [current Flare model](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare), and [API pricing](https://developers.openai.com/api/docs/pricing). The app pins its supported GPT Image 2 profile; the existence of a newer model does not silently change an approved quote.
