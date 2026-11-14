# Main backend handoff to social-media

The small business promo backend is ready for integration on `main`. The completed integration commit has the subject **Connect business photo refinement, approval, and video publishing APIs**. Fetch main and merge that commit before mounting the social module. Earlier foundation commits are `cc07a69` and `e6d278c`; both passed GitHub CI.

## Ownership and compatibility

- This session owns `apps/api`, the workflow/render shared contracts, and backend documentation. At the explicit coordination request, the existing `apps/web` baseline was committed as `d87409a` after a passing production build, without implementation changes. Further frontend work belongs to the separate frontend session; social files belong exclusively to `apps/web/src/social/*`.
- Social work should remain additive in `apps/api/src/social-*`, `apps/web/src/social/*`, and the `@yap/contracts/social` export. Keep `@yap/contracts` legacy types and the new `./workflow` / `./render` exports intact.
- The original `/api/projects` routes remain compatible. New business promo work uses `/api/workflows`.
- An optional `SocialHandoff` addition to legacy project data is acceptable if existing stored records and API fixtures still parse, omitted PATCH fields stay unchanged, and research remains attributed creative context. Keep creation defaults out of partial update schemas.
- Preserve individual commits when merging. Do not squash the social feature unless explicitly requested for that merge.

## API integration

Mount `/api/social` in `apps/api/src/app.ts` after JSON/body and CORS middleware and before the final not-found middleware. The workflow router is already mounted at `/api/workflows`; do not replace it.

`createApp` now accepts workflow data, photo, video, provider, and renderer configuration for isolated tests. It sets `app.locals.shutdown` to stop the render queue. If the social module needs cleanup, compose shutdown functions rather than overwriting the existing one. Use a separate social data file; never write workflow JSON or photo paths from the social module.

The shared error envelope is `{ error: { code, message, details? } }`. Browser CORS defaults to `http://127.0.0.1:5173`. Keep provider secrets server-only and report missing live providers rather than inventing retrieved results.

## Research to promo handoff

The frontend's `SocialWorkspace.onUseResearch(handoff, investigation)` should map selected research into a **new workflow draft or explicit refinement**, not approve or render it automatically.

1. Retain the investigation ID, source URLs, observation dates, and distinction between observed network/content data and a generated interpretation in the handoff.
2. Put a short, clearly attributed research summary in `POST /api/workflows` `input`, or submit it as a creator refinement for an existing workflow using its current `expectedVersion`.
3. Populate `brief` only with business facts actually supplied by the creator. Competitor captions, inferred audience ideas, and observed engagement are creative research context, not verified claims about the creator's product.
4. Attach the creator's own photos through the workflow asset endpoints. Do not silently reuse competitor photos or pass arbitrary remote image URLs to the renderer.
5. Use `/prepare` to create proposals, let the creator edit/review them, then require explicit `/approve-all` before enqueueing `/renders`.

`prepare` preserves current creator edits by default, rebuilding missing scenes after a script edit. Only `regenerate: true` intentionally replaces existing material. `/scenes/prepare` rebuilds scene proposals without requiring prior approval. No social handoff should call approval on the creator's behalf.

See [the complete workflow contract](../promo-backend.md) for requests, responses, raw photo upload examples, polling, and the MP4/caption publish kit. Querying `/api/workflows/:id/query` is read-only and returns current version and scoped evidence references.

## Feature return

After syncing main, send the social feature branch name and tested commit SHA, the source/provider behavior exercised, and the exact callback/HTTP handoff shape. Keep social tests isolated in temporary stores. Run `npm run typecheck:api`, `npm run test:api`, and `npm run build:api`; the frontend owner should also run its own checks. Main will merge the reviewed feature with a regular merge commit after those results are available.

No computer-use or browser automation is authorized for this work. Use source, HTTP tests, and CLI checks.
