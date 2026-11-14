# API and collaboration contract

Source of truth: [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) and [`apps/api/src/app.ts`](../apps/api/src/app.ts). This document describes the first local implementation, not a hosted or authenticated service.

For the new business photo-to-promo flow, use the additive [`/api/workflows` integration guide](promo-backend.md) and the `@yap/contracts/workflow` / `@yap/contracts/render` exports. The `/api/projects` endpoints documented here remain compatible.

## Run independently

Use Node.js 22.12 or newer and run `npm install` once at the repository root. Build shared runtime schemas before starting either app:

```powershell
npm run build --workspace=@yap/contracts
```

Then use separate terminals:

```powershell
# Backend terminal
npm run dev:api

# Frontend terminal
npm run dev:web
```

`npm run dev` starts both. The web app serves at `http://127.0.0.1:5173`; the API listens at `http://127.0.0.1:3001`. The frontend calls `/api` through Vite's development proxy. For another API deployment, set `VITE_API_BASE_URL` to its origin, without `/api`, in `apps/web/.env` and restart Vite. This is public browser configuration; never put secrets in a `VITE_` variable.

The backend optionally reads `apps/api/.env`. Defaults:

| Variable        | Default                 | Purpose                                                                                                |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `HOST`          | `127.0.0.1`             | Bind address                                                                                           |
| `PORT`          | `3001`                  | API port                                                                                               |
| `CORS_ORIGIN`   | `http://127.0.0.1:5173` | Exact allowed browser origin                                                                           |
| `API_DATA_FILE` | `./data/projects.json`  | Durable project file, relative to the API process working directory (`apps/api` for workspace scripts) |

Browser origins must match `CORS_ORIGIN`; requests without an `Origin` header, such as curl, are allowed. CORS is not authentication. This local service has no accounts or authorization boundary. Do not treat it as an internet-ready multiuser service.

## Routes

All paths below include the `/api` prefix. JSON mutations use `Content-Type: application/json`. IDs must be UUIDs. Responses use `Cache-Control: no-store`.

| Method and path                                | Request                             | Successful response                                                   |
| ---------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `GET /api/health`                              | None                                | `200` with `{"status":"ok","service":"yap-api","generator":"guided"}` |
| `GET /api/projects`                            | None                                | `200` with `{ projects: Project[] }`, newest `updatedAt` first        |
| `POST /api/projects`                           | `CreateProjectInput`                | `201` with `{ project: Project }` and `Location: /api/projects/:id`   |
| `GET /api/projects/:id`                        | None                                | `200` with `{ project: Project }`                                     |
| `PATCH /api/projects/:id`                      | Nonempty `UpdateProjectInput`       | `200` with `{ project: Project }`                                     |
| `DELETE /api/projects/:id`                     | None                                | `204`, no response body                                               |
| `POST /api/projects/:id/generate`              | No body, or `{}`                    | `200` with `{ project: Project }`                                     |
| `GET /api/projects/:id/export?format=markdown` | None; format defaults to `markdown` | `200` Markdown attachment                                             |
| `GET /api/projects/:id/export?format=json`     | None                                | `200` JSON attachment containing `{ project: Project }`               |

There is no pagination or search parameter. Filter the returned list in the client for this iteration. Exports are permitted before generation: Markdown includes the brief and a note that no script exists; JSON includes `draft: null`.

## Project data

Creation accepts only the following keys; unknown properties are rejected. Required text fields are trimmed before length validation.

| Field      | Allowed value                           | Creation default |
| ---------- | --------------------------------------- | ---------------- |
| `title`    | String, 1 to 120 characters             | Required         |
| `idea`     | String, 10 to 4,000 characters          | Required         |
| `audience` | String, 2 to 200 characters             | Required         |
| `platform` | `instagram`, `tiktok`, `youtube`        | `instagram`      |
| `duration` | Number: `15`, `30`, or `60`             | `30`             |
| `tone`     | `conversational`, `educational`, `bold` | `conversational` |
| `goal`     | `educate`, `entertain`, `promote`       | `educate`        |

The server adds `id`, `status` (`draft` or `ready`), nullable `draft`, `createdAt`, and `updatedAt`. Dates are UTC ISO strings with a `Z` suffix. New projects start with `status: "draft"` and `draft: null`.

A generated draft contains:

```ts
type VideoDraft = {
  hook: string; // 1..1000 characters, trimmed
  script: string; // 1..10000 characters, trimmed
  caption: string; // 0..3000 characters
  hashtags: string[]; // at most 20 strings, each at most 100 characters
  shots: Shot[]; // 1..12 shots
  provider: 'guided';
  generatedAt: string; // UTC ISO timestamp
};

type Shot = {
  id: string; // 1..100 characters; unique within this draft
  seconds: number; // integer 1..60; all shots sum to project.duration
  visual: string; // 1..1000 characters, trimmed
  voiceover: string; // 1..2000 characters, trimmed
  onScreenText: string; // 0..300 characters
};
```

The guided generator is deterministic template logic using the saved brief. It does not call an AI provider, create footage, or render an MP4. Regenerating replaces the previous draft and returns the project to `draft` status.

## PATCH behavior

- Send only changed brief fields and/or `status`. Omitted fields remain unchanged; creation defaults do not apply to PATCH. An empty object is invalid.
- A changed brief field, including `title`, invalidates the old draft and resets status to `draft`. Save the brief, then generate again.
- To edit a generated draft, send a complete `draft` content object: `hook`, `script`, `caption`, `hashtags`, and `shots`. Partial nested draft updates are unsupported. Do not send `provider` or `generatedAt`; the server preserves them.
- Editing a draft requires an existing generated draft. Shot IDs must be unique and shot durations must total the current project duration.
- Do not send a changed brief and a draft edit in one request. Marking a project `ready` requires a draft.

## Errors

All API errors follow this envelope; `details` is optional. Validation paths use dot notation, for example `draft.shots.0.seconds`.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Check the project details and try again.",
    "details": [{ "path": "idea", "message": "Validation explanation" }]
  }
}
```

| HTTP status | Codes                                                                                                                           | Client action                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `400`       | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_PROJECT_ID`, `INVALID_EXPORT_FORMAT`, `INVALID_SHOT_DURATION`, `DUPLICATE_SHOT_ID` | Correct the request; show field details when provided                |
| `403`       | `ORIGIN_NOT_ALLOWED`                                                                                                            | Align browser origin with backend configuration                      |
| `404`       | `PROJECT_NOT_FOUND`, `NOT_FOUND`                                                                                                | Refresh the list or correct the route                                |
| `409`       | `DRAFT_REQUIRED`, `BRIEF_AND_DRAFT_CONFLICT`                                                                                    | Generate first, or save brief and draft changes separately           |
| `413`       | `BODY_TOO_LARGE`                                                                                                                | Keep JSON below the 128 KB body limit                                |
| `500`       | `STORAGE_ERROR`, `INTERNAL_ERROR`                                                                                               | Show the message and allow retry; inspect server logs if it persists |

## Try the API in PowerShell

Use `curl.exe` explicitly on Windows because `curl` may resolve to a PowerShell alias. This example uses PowerShell's JSON serialization for mutation requests, avoiding native-shell JSON quoting differences.

```powershell
$api = 'http://127.0.0.1:3001/api'
curl.exe -i "$api/health"
curl.exe -i "$api/projects"

$brief = @{
  title = 'A better morning coffee'
  idea = 'Show three simple ways to make a better cup of coffee at home.'
  audience = 'People making their first pour over'
  platform = 'instagram'
  duration = 30
  tone = 'educational'
  goal = 'educate'
} | ConvertTo-Json

$created = Invoke-RestMethod -Uri "$api/projects" -Method Post -ContentType 'application/json' -Body $brief
$id = $created.project.id

# No body: generation uses the saved brief.
curl.exe -i -X POST "$api/projects/$id/generate"

# Status-only PATCH leaves the brief and draft unchanged.
Invoke-RestMethod -Uri "$api/projects/$id" -Method Patch -ContentType 'application/json' -Body '{"status":"ready"}'

curl.exe --fail-with-body -o yap-plan.md "$api/projects/$id/export?format=markdown"
curl.exe --fail-with-body -o yap-project.json "$api/projects/$id/export?format=json"

# Permanently removes this example project.
curl.exe -i -X DELETE "$api/projects/$id"
```

For curl-only mutations, save valid UTF-8 JSON to a file and use `curl.exe -H "Content-Type: application/json" --data-binary "@brief.json" "$api/projects"`. Never commit API data files or credentials.

## Shared-package change discipline

1. Frontend work belongs in `apps/web`; backend work belongs in `apps/api`. Both import schemas and types from `@yap/contracts`, not each other's implementation files.
2. Coordinate changes to `packages/contracts` before changing the wire format. Additive changes still need consumer checks; removing fields, changing defaults/enums, or changing response envelopes requires coordinated updates.
3. Rebuild contracts after modifying them. Their package exports runtime JavaScript from `dist` and TypeScript types from `src`; stale build output can otherwise disagree with source types.
4. Update this document and relevant boundary tests with contract changes. Run root `npm run build`, `npm run typecheck`, and `npm test` before integration.
5. The shared package is private and currently `0.1.0`; it is consumed inside this workspace. If separately released later, introduce an explicit versioning and compatibility policy before allowing independent deployments.

Verified developer sources, November 13, 2026: [Vite getting started](https://vite.dev/guide/) documents the React TypeScript template, Node 20.19+/22.12+ requirement, and dev/build workflow. Yap uses the stricter repository floor of Node 22.12+. [Zod v4 migration guide](https://zod.dev/v4/changelog#defaults-applied-within-optional-fields) documents defaults inside optional properties; this is why PATCH uses a brief schema without creation defaults. [Zod schema API](https://zod.dev/api#iso-datetimes) documents UTC datetime validation.
