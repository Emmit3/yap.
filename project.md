# Yap working product brief

This brief was created during the initial implementation on November 13, 2026. It is a working proposal inferred from the README tagline, not the missing original specification.

## Confirmed direction

- Build actual source, using multiple agents and external research.
- Separate frontend and backend implementation so developers can work independently.
- Keep the shared interface explicit and provide a usable local development workflow.

## Working product assumption

Yap helps an independent creator turn an idea into a short video recording plan. The first usable flow is **idea → brief → editable starter script and shot plan → export**.

The creator sets an audience, platform, duration, tone, and goal. They can save projects, return to them, edit the script and shots, mark a plan ready, and export Markdown or JSON.

The first engine uses guided templates and identifies that behavior in the UI and API. No AI provider, MP4 rendering, uploaded media processing, social publishing, billing, or account system is implied.

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

## Decisions still needed before expanding

Confirm the creator audience and whether the main output should be a script, rendered video, or clips from existing video. Choose model and media providers only after that decision. Developer collaboration in this repository is separate from multiple users editing the same project in the product.

See [research](docs/product-research.md) for source evidence and [architecture](docs/architecture.md) for implementation boundaries.
