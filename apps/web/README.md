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

## Ownership

- `src/App.tsx`: workspace shell, routes, project index, navigation guard.
- `src/ProjectLibrary.tsx`: saved projects, search, filters, empty and connection states.
- `src/NewProject.tsx`: brief validation and creation.
- `src/ProjectEditor.tsx`: script, shot plan, brief editing, ready state, export, deletion.
- `src/api.ts`: the only network boundary. It validates backend responses with shared runtime schemas.
- `src/components.tsx`: shared form fields, feedback, labels and presentation primitives.
- `src/styles.css`: responsive design tokens and styles.

Frontend work can proceed without editing `apps/api`. Coordinate changes to `packages/contracts` with both teams first. The app shows a connection error rather than silently replacing server data with mock data.

## Current behavior

Projects are real backend records. Create a brief, create a guided draft, edit its script and timed shots, mark it ready, and download Markdown or JSON. The generator is a structured template, not an AI or video rendering service. Brief changes clear the generated draft on the server; the UI explains that before saving. Script and shot plan changes must be saved before export or ready status. Durations must add up to the selected video length.

`npm run typecheck --workspace=@yap/web` checks frontend types. `npm run build --workspace=@yap/web` checks types and builds static assets into `apps/web/dist`. The built frontend can be hosted independently of the Node API. Set its API origin at build time when deploying separately; Vite's development proxy does not exist in production.
