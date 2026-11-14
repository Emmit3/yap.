# yap.

Good ideas, made REEL.

Yap helps a small business turn its photos and an idea into a promo. The backend now supports **photos → refinement → script and scenes → creator approval → downloadable MP4 and caption**. A matcha shop can upload drink and shop photos, describe what it wants to highlight, and prepare a vertical promo.

The frontend connects the cinematic landing page, social research, and the photo promo studio to this flow. See the [frontend guide](apps/web/README.md) for routes and the [promo backend integration guide](docs/promo-backend.md) for the API. The new endpoints are additive under `/api/workflows`; the existing `/api/projects` API is preserved.

The guided provider runs without a key and composes real uploaded photos with editable template copy. Select the optional OpenAI provider for natural language interpretation and image understanding. Both produce reviewable proposals; neither automatically approves factual claims.

## Run locally

Use Node.js **22.12 or newer** and npm. From the repository root:

```sh
npm install
npm run dev
```

The API runs at **http://127.0.0.1:3001**. When `apps/web` is present, the development command also starts it at **http://127.0.0.1:5173**. For backend development alone, run `npm run dev:api`. Stop with Ctrl+C.

No API key or database service is required for guided preparation and photo rendering. Set `WORKFLOW_PROVIDER=openai` and a server-only `OPENAI_API_KEY` in `apps/api/.env` to enable the model adapter. Runtime data and `.env` files are ignored by Git.

Video output is a real **1080×1920 H264 MP4 at 24 fps**, using the supplied photos, branded text overlays, and the approved scene timing. Videos are silent. The publish kit includes the caption and video download; automatic social posting is not connected. This remains a local single-workspace service without user accounts.

## Separate frontend and backend work

| Location                                   | Responsibility                                                         | Run independently from the root            |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------ |
| [`apps/web`](apps/web)                     | React interface, brief and script editing, project navigation, exports | `npm run dev:web`                          |
| [`apps/api`](apps/api)                     | HTTP API, persistence, generation service, validation                  | `npm run dev:api`                          |
| [`packages/contracts`](packages/contracts) | Shared schemas and TypeScript request/response types                   | `npm run build --workspace=@yap/contracts` |

The frontend talks only to HTTP endpoints. It does not import backend source. The backend does not import frontend source. Each application has its own package, build configuration, environment example, and README.

See [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md), and the [API contract](docs/api.md) for team workflows and integration details.

The cinematic landing source is preserved under `public/` and synced into the React production build. Its studio and research navigation opens the connected workspace. Run `npm run dev:showcase` for the standalone reference on port 4173, or `npm run build:showcase` for a static build. Its motion checks run with `npm run check:showcase`; media provenance and design notes are in [the landing guide](docs/cinematic-landing.md).

## Checks and builds

```sh
npm run typecheck
npm test
npm run build
```

Backend-only checks: `npm run typecheck:api`, `npm run test:api`, and `npm run build:api`. They do not require frontend source.

`npm run test:promo-ui` checks the frontend/API handoff and navigation bridge without a browser. `npm run smoke:promo-ui` uses a temporary guided API and the real encoder to write `artifacts/frontend-promo-smoke.mp4`; it does not touch developer projects. Generated artifacts are ignored by Git.

The production frontend is emitted to `apps/web/dist`; the API to `apps/api/dist`; shared runtime schemas to `packages/contracts/dist`. Deploy the frontend and API separately. Configure the frontend API URL at build time and the backend's allowed frontend origin for the deployed environment. The development Vite proxy is not a production proxy.

The API's JSON stores are intended for one server process with a persistent writable disk. Workflow updates use optimistic versions and keep the latest 50 snapshots. Render jobs run in a bounded queue, retain immutable source references, and recover interrupted jobs on restart. See [architecture](docs/architecture.md) and the API README before running outside local development.
