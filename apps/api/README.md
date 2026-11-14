# Yap API

The new small business promo workflow is documented in [the frontend integration guide](../../docs/promo-backend.md). It adds photo inputs, natural language refinement, queryable state, explicit approval, durable render jobs, and real vertical MP4 output under `/api/workflows`. The original project API below remains compatible.

For a matcha shop, the short path is create → upload photos → prepare → approve all → render → publish kit. Detailed brief/script/scene endpoints support further refinement. Run backend-only checks with root `npm run typecheck:api`, `npm run test:api`, and `npm run build:api`.

Independent TypeScript/Express service. The web app only communicates with it over HTTP. Shared request/response types and runtime schemas live in `packages/contracts`; there are no imports from the frontend.

From the repository root:

```sh
npm install
npm run build --workspace=@yap/contracts
npm run dev:api
```

The API listens on `http://127.0.0.1:3001`. To change settings, copy `.env.example` to `.env` inside `apps/api`. Environment files are optional. Relative `API_DATA_FILE` paths resolve from `apps/api` when launched with a workspace npm command.

```sh
npm run typecheck --workspace=@yap/api
npm run test --workspace=@yap/api
npm run build --workspace=@yap/api
npm run start --workspace=@yap/api
```

## HTTP contract

All routes use the `/api` prefix. Errors return `{ "error": { "code": "...", "message": "...", "details": [] } }`; `details` is present for field validation errors only. Requests accept up to 128 KB of JSON. See `docs/api.md` for the complete collaboration contract.

| Method | Route                                      | Behavior                                                         |
| ------ | ------------------------------------------ | ---------------------------------------------------------------- |
| GET    | `/api/health`                              | Reports health and `generator: "guided"`                         |
| GET    | `/api/projects`                            | Lists saved projects, most recently updated first                |
| POST   | `/api/projects`                            | Validates and saves a brief; returns 201                         |
| GET    | `/api/projects/:id`                        | Retrieves one project                                            |
| PATCH  | `/api/projects/:id`                        | Updates brief, status, or complete draft content                 |
| DELETE | `/api/projects/:id`                        | Deletes one project; returns 204                                 |
| POST   | `/api/projects/:id/generate`               | Creates a guided script and timed shot plan from the saved brief |
| GET    | `/api/projects/:id/export?format=markdown` | Downloads brief and plan as Markdown                             |
| GET    | `/api/projects/:id/export?format=json`     | Downloads the full saved project as JSON                         |

Generation is a deterministic template aid, not an AI model or video renderer. It uses the supplied idea without fetching facts. Regenerating replaces the current draft and returns the project to `draft`. A brief edit invalidates the old draft. A project can be marked `ready` only after a draft exists. Draft edits preserve generation provenance, require unique shot IDs, and require the total shot duration to match the brief.

## Storage and deployment boundaries

The service stores projects in `data/projects.json`. It creates the file on the first write. Changes are serialized in a single process and written through an atomic rename; malformed storage prevents startup instead of silently deleting records. Back up the data file before editing or migrating it.

Run one API process per data file. This local development service has no user accounts or authorization and binds to loopback by default. A shared hosted product needs authentication, project ownership, a transactional database, revision conflict handling, and rate limits before exposing it to the internet. CORS permits the single configured frontend origin and does not replace authorization.

The repository is isolated behind `ProjectRepository`, and drafting is isolated in `generateGuidedDraft`. Replace those boundaries when introducing a database or an external generation provider. Keep HTTP responses compatible with `@yap/contracts` or coordinate contract changes with the frontend team.

Express 5 promise error handling was verified against its [official error handling guide](https://expressjs.com/en/guide/error-handling/).
