# yap.

Good ideas, made REEL.

Yap is a short video planning workspace. Capture an idea, create an editable starter script and shot plan, and export a recording brief. This first implementation uses a **guided template engine**, not a connected AI model. It exports Markdown and JSON plans, not rendered video.

The repository originally contained only this tagline; the working product direction is documented in [project.md](project.md) and informed by [official product research](docs/product-research.md).

## Run locally

Use Node.js **22.12 or newer** and npm. From the repository root:

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs at **http://127.0.0.1:3001**. The development command builds the shared contract, then starts both services. Stop both with Ctrl+C.

No API key or database service is required. Projects are persisted locally by the API; runtime data and `.env` files are ignored by Git. This is a local, single workspace application. Authentication, multiuser access, model integrations, and video rendering are not implemented.

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

The production frontend is emitted to `apps/web/dist`; the API to `apps/api/dist`; shared runtime schemas to `packages/contracts/dist`. Deploy the frontend and API separately. Configure the frontend API URL at build time and the backend's allowed frontend origin for the deployed environment. The development Vite proxy is not a production proxy.

The API's JSON store is intended for one server process with a persistent writable disk. See its README before running outside local development.
