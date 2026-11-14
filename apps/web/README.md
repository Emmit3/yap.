# Yap frontend

The React application owns the creator experience. It has no server imports and talks to the backend only over the shared HTTP contract in `packages/contracts`.

From the repository root:

```sh
npm install
npm run build --workspace=@yap/contracts
npm run dev:web
```

Open `http://127.0.0.1:5173`. Start the API separately with `npm run dev:api`, or start both with root `npm run dev`.

The Vite dev server proxies `/api` to `http://127.0.0.1:3001`. For a separately deployed backend, copy `.env.example` to `.env` and set `VITE_API_BASE_URL` to its origin, without `/api`. Configure the backend CORS origin to match the frontend origin. This is a public build setting; never put a secret in a `VITE_` variable.

## Routes and behavior

- `/`: the cinematic five-row video wall, phone reveal, and filmstrip. Its primary action opens the connected photo promo studio.
- `#/promos`: searchable saved promos.
- `#/promos/new`: the creator's idea, own business facts, and photos.
- `#/promos/:id`: editable copy, timing, scenes, photo choices, refinement questions, explicit approval, render status, MP4 and caption.
- `#/social`: the separately owned social research workspace.
- `#/projects`, `#/new`, and `#/projects/:id`: the existing script-planning records and Markdown/JSON exports.

The photo promo path uploads raw image files sequentially using the latest returned workflow version. Preparation creates a proposal and never approves it. Saving content invalidates affected approvals. The creator must review the saved facts, copy, timings, and photos, then explicitly choose **Approve and render video**.

Queued/running renders are polled until a terminal status. Stopping status checks or leaving the editor does not cancel the server job; reopening the saved promo resumes it. Completed output is shown as the current promo only when its workflow version matches. Videos are silent portrait MP4s made from supplied photos, with a caption for manual posting. The interface does not claim to generate new footage or post to accounts.

## Reviewed research handoff

`SocialWorkspace.onUseResearch` provides a reviewed `SocialHandoff`. The shell validates its shared schema and 48 KiB serialized limit, retains it in session storage where available, and opens a new promo. The creator still supplies the business request, facts, and photos. The client sends research as a separate `research` field; it is never silently copied into product claims. Saved research retains source URLs, excerpts, dates, and cautions. No handoff calls approval or rendering.

Unsaved creator changes and social notes use the shared navigation guard. A version conflict preserves a downloadable local backup and requires explicit comparison/recovery. Unknown network outcomes are not automatically replayed.

## Ownership

- `src/App.tsx`, `src/shell.css`, `src/research-context.ts`: shared routes, navigation guards, and research handoff.
- `src/landing/*`: isolated cinematic landing wrapper and checked iframe message bridge.
- `src/promo/*`: photo promo API client, creator editor, library, and scoped monochrome styles.
- `src/social/*`: exclusively maintained by the social module owner; mounted through its public props.
- `src/ProjectLibrary.tsx`, `src/NewProject.tsx`, `src/ProjectEditor.tsx`, `src/api.ts`: compatible legacy script planner.
- `src/components.tsx`, `src/styles.css`: shared controls and baseline styles.

Frontend source does not import API implementation files. Client responses are validated through shared contracts. Source/HTTP integration tests may launch a temporary API to exercise that boundary. Live provider failures are shown rather than replaced with fabricated retrieved data.

## Builds and checks

`npm run typecheck --workspace=@yap/web` checks frontend types. `npm run build --workspace=@yap/web` syncs the showcase, checks types, and emits `apps/web/dist`. `scripts/sync-showcase.mjs` copies `public/` to ignored `apps/web/public/showcase/`, avoiding duplicate tracked media. The production bundle contains the cinematic page and all its local media.

From the root, run `npm run test:promo-ui` for client/HTTP and bridge tests, and `npm run smoke:promo-ui` for a real 15-second encoded example in ignored `artifacts/`. Full workspace checks are `npm run typecheck`, `npm test`, and `npm run build`.

The frontend can be hosted independently of the API. Set its API origin at build time; Vite's development proxy does not exist in production.
