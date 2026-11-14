# yap.

Good ideas, made REEL.

Yap helps a small business turn its photos and an idea into a promo. The backend now supports **photos → refinement → script and scenes → creator approval → downloadable MP4 and caption**. A matcha shop can upload drink and shop photos, describe what it wants to highlight, and prepare a vertical promo.

Start with the [promo backend integration guide](docs/promo-backend.md). The new endpoints are additive under `/api/workflows`; the existing `/api/projects` API is preserved. The frontend is being developed in a separate session and needs to connect to this new promo flow.

The guided provider runs without a key and composes real uploaded photos with editable template copy. Select the optional OpenAI provider for natural language interpretation and image understanding. Both produce reviewable proposals; neither automatically approves factual claims.

## Run locally

Use Node.js **22.12 or newer** and npm. From the repository root:

```sh
npm install
npm run dev
```

The API runs at **http://127.0.0.1:3001**. When `apps/web` is present, the development command also starts it at **http://127.0.0.1:5173**. For backend development alone, run `npm run dev:api`. Stop with Ctrl+C.

No API key or database service is required for guided preparation and photo rendering. Set `WORKFLOW_PROVIDER=openai` and a server-only `OPENAI_API_KEY` in `apps/api/.env` to enable the model adapter. Runtime data and `.env` files are ignored by Git.

The configuration format is published in the root [`.env.example`](.env.example). For a fresh checkout, copy it to `apps/api/.env` and copy `apps/web/.env.example` to `apps/web/.env`. The API loads its own environment file; the frontend uses only public `VITE_` settings. Fill actual keys only in the ignored `.env` files. Dependencies are managed by npm through `package.json` and `package-lock.json`; [requirements.txt](requirements.txt) records the runtime setup and requires no Python packages.

See the [API provider setup](docs/api-providers.md) for OpenAI, Deep Agents, Firecrawl, X, and xAI configuration. The optional [AWS S3 example](docs/aws-s3.md) uploads a rendered MP4 to a private bucket and returns a temporary download link:

```sh
npm run aws:upload -- ./data/videos/RENDER_ID.mp4
```

This upload path resolves from `apps/api`, where the default render directory lives. Set the AWS variables in `apps/api/.env` and configure credentials before running the command.

Video output is a real **1080×1920 H264 MP4 at 24 fps**, using the supplied photos, branded text overlays, and the approved scene timing. Videos are silent. The publish kit includes the caption and video download; automatic social posting is not connected. This remains a local single-workspace service without user accounts.

## Separate frontend and backend work

| Location                                   | Responsibility                                                         | Run independently from the root            |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------ |
| [`apps/web`](apps/web)                     | React interface, brief and script editing, project navigation, exports | `npm run dev:web`                          |
| [`apps/api`](apps/api)                     | HTTP API, persistence, generation service, validation                  | `npm run dev:api`                          |
| [`packages/contracts`](packages/contracts) | Shared schemas and TypeScript request/response types                   | `npm run build --workspace=@yap/contracts` |

The frontend talks only to HTTP endpoints. It does not import backend source. The backend does not import frontend source. Each application has its own package, build configuration, environment example, and README.

See [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md), and the [API contract](docs/api.md) for team workflows and integration details.

## Checks and builds

```sh
npm run typecheck
npm test
npm run build
```

Backend-only checks: `npm run typecheck:api`, `npm run test:api`, and `npm run build:api`. They do not require frontend source.

The production frontend is emitted to `apps/web/dist`; the API to `apps/api/dist`; shared runtime schemas to `packages/contracts/dist`. Deploy the frontend and API separately. Configure the frontend API URL at build time and the backend's allowed frontend origin for the deployed environment. The development Vite proxy is not a production proxy.

The API's JSON stores are intended for one server process with a persistent writable disk. Workflow updates use optimistic versions and keep the latest 50 snapshots. Render jobs run in a bounded queue, retain immutable source references, and recover interrupted jobs on restart. See [architecture](docs/architecture.md) and the API README before running outside local development.
