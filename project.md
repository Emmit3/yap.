# Yap working product brief

This brief was created during implementation on November 13, 2026, then revised after the user clarified the small business promo use case. It does not claim to reproduce the missing original specification.

## Confirmed direction

- Build actual source, using multiple agents and external research.
- Separate frontend and backend implementation so developers can work independently.
- Keep the shared interface explicit and provide a usable local development workflow.

## Confirmed product direction

Yap should be easy for a business such as a matcha shop: supply photos of the shop and drinks, describe what to highlight, refine the idea, and receive a promo it can post. The main path is **photos and natural language → reviewable promo → explicit approval → MP4 and caption**.

The backend prepares the brief, script, and scenes beneath this simple flow. Defaults keep setup short; refinement questions help when useful. A query endpoint explains the saved idea, open questions, script, and scenes. Detailed stage approval endpoints remain available, while one final approval supports the main product flow.

The backend supports a local guided provider, optional OpenAI text/vision services, photo uploads and MP4 rendering. Photo promos preserve supplied photography and remain silent. Creator films support explicit per-shot fal Seedance 2.5 profiles, native 720p portrait/landscape delivery or labeled portrait 1080p resizing, optional narration/music and burned-in script subtitles with a separate SRT export. The historical fal Seedance 1.5 profile is retired and cannot start new generation. Posting remains manual; accounts and customer billing are not implemented.

Per-workspace brand settings can be explicitly snapshotted into a reviewed plan. Separate versioned edits trim/reorder a finished film, add transitions/text and render free previews without changing generation receipts or renewing paid attempts. Quoted storyboard PNGs and timestamped reference imports/sample analysis are implemented with distinct provenance and spending approvals. These local capabilities do not establish funded provider access or completed real-provider rehearsals. See [branding/editing](docs/creator-brand-edit.md), [reference assets](docs/creator-reference-assets.md) and the [Mori Drinks presenter path](docs/demo-presenter.md).

## Acceptance criteria for this implementation

- Frontend and API run as separate applications with a shared validated contract.
- Project creation and edits persist across API restarts.
- Draft generation produces a hook, script, caption, hashtags, and timed shot plan.
- Shot durations add up to the target duration.
- Editing a brief clears a stale plan; marking ready requires a valid plan.
- Projects can be searched, filtered, deleted, and exported from the UI.
- Empty, loading, error, and offline states provide a clear next action.
- The interface works on a phone and with keyboard navigation.
- Automated checks exercise API behavior, persistence, and shared contract regressions.

Backend promo acceptance criteria:

- A shop can begin with incomplete natural language and uploaded PNG, JPEG, or WebP photos.
- Explicit answers take precedence over model suggestions.
- Preparation produces a complete proposed script and scenes without pretending they are approved.
- Verification reports distinguish structural checks from factual certainty and creator approval.
- Changes invalidate downstream artifacts and approvals; stale clients receive a conflict rather than overwriting newer work.
- Approved scenes render into an actual 1080×1920 H264 MP4 with exact duration and supplied photos.
- Query, history, render status, range-capable video preview/download, and caption handoff are available over HTTP.
- Photo files and render intermediates remain scoped to their workflow; failures and restarts preserve truthful job state.
- Frontend source remains owned by the other session; backend progress is committed and pushed in batches.

## Decisions still needed before expanding

Choose user identity, deployment storage and social publishing integrations before expanding beyond the local service. Brand controls currently belong to one local workspace; per-account brand ownership still depends on accounts and tenant isolation. Developer collaboration in this repository is separate from multiple businesses having isolated data.

See [research](docs/product-research.md) for source evidence and [architecture](docs/architecture.md) for implementation boundaries.
