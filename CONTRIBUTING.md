# Contributing to Yap

## Setup

Install Node.js 22.12+ and run `npm install` at the repository root. The root lockfile covers all workspaces; do not create application-local lockfiles. After the first install, use `npm ci` for reproducible installation.

For both services run `npm run dev`. For separate terminals or developers, run `npm run dev:web` and `npm run dev:api` independently. Each command prepares the shared contract first. Copy the relevant application's `.env.example` to `.env` only when changing defaults.

## Divide ownership

- Frontend changes belong in `apps/web`. Use the API client and shared schemas rather than importing server files.
- Backend changes belong in `apps/api`. Keep request handling, storage, and generation responsibilities separate.
- Request/response changes belong in `packages/contracts`, with coordinated frontend, backend, API documentation, and regression test changes.
- Root tooling and the lockfile affect everyone. Coordinate dependency changes and run installation once after package declarations settle.

The API can run while the frontend is changed, and the frontend can point at another developer's API using its configured base URL. Local network use requires deliberate API binding and CORS configuration; the defaults bind to loopback.

## Contract changes

Agree on an endpoint and schema change before changing either consumer. Add the shared type/validator, implement the backend, then adapt the UI. Optional additions are preferable to silently changing existing meanings. Rebuild `@yap/contracts` and restart development services after shared runtime schema changes.

Keep defaults on creation schemas rather than on partial update schemas. A sparse PATCH must preserve fields the caller did not send. Keep generated metadata server owned.

## Validate a change

```sh
npm run typecheck
npm test
npm run build
```

For UI changes, also exercise the affected flow in a browser, including a narrow viewport and an error state. For API changes, test behavior through HTTP and use a temporary data path so tests do not touch developer projects.

Do not commit `.env`, credentials, generated builds, or project data. Do not silently replace a corrupted data store with an empty file.

## Pull requests

Describe the behavior changed, the checks run, and any environment or contract migration. Keep changes within the owning application when possible. Preserve individual commits with a regular merge commit when merging; squash only when explicitly requested for that merge.
