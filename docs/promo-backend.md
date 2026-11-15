# Product photo to promo backend

This is the integration guide for the frontend session. Keep frontend work in `apps/web`; the workflow implementation is in `apps/api`. The existing `/api/projects` interface remains available. New promo work uses `/api/workflows` and the additive `@yap/contracts/workflow` and `@yap/contracts/render` exports.

The main flow is: **describe the business → attach photos → prepare a proposal → review → approve and render → download video and caption**. A matcha shop can start with a sentence and its drink photos, then answer questions such as “What do you want people to like about it?” without rebuilding the project.

## Frontend flow

1. Create a workflow from natural language. The brief can be incomplete; the server supplies editable platform, tone, duration, and local business defaults.
2. Upload one or more business/product photos. Show the supplied images and allow a creator description for each image.
3. Use `prepare` for the fast path. It refines available input and proposes a script and scene plan in one call. It does not approve the proposal.
4. Show the proposed copy, scene timing, photo choices, and open refinement questions. Submit answers or a free text refinement, then prepare again if the creator changes direction.
5. Only after the creator explicitly reviews and accepts the proposal, call `approve-all`, followed by `renders` with the returned workflow version.
6. Poll the render job until `succeeded` or `failed`. A queued job is not a video. Show an actionable failure and allow a new render after correction.
7. On success, display the completed MP4 and caption for download/manual posting.

Creators can edit proposed scripts and scenes **before approval**. After a script edit clears its old scenes, call `prepare` again to rebuild just the missing scenes, or call `/scenes/prepare` explicitly. Existing current copy and scenes are preserved by default. Repeated preparation with nothing missing is a no-op. Only send `regenerate: true` after an explicit request to replace existing creative material.

The `canApprove` flag belongs to each detailed stage's ordered approval path. For the main final-review action, enable `approve-all` when no report is `blocked`; unapproved upstream stages may still make an individual later stage's `canApprove` false. Do not force separate approvals in the main shop flow.

The output is a real **1080 × 1920 portrait MP4**, encoded as H.264 at 24 fps with browser-friendly pixel format and fast start. It uses uploaded photos, scene copy, and the business call to action. This initial renderer produces **no audio or voiceover** and does not generate new footage. It does not post to social accounts. “Ready to post” here means an exported video and caption that the creator can review and upload themselves.

## Run and configuration

From the repository root, install dependencies once with `npm install`, then run `npm run dev:api`. The default API origin is `http://127.0.0.1:3001`; the frontend development proxy exposes it at `/api` on `http://127.0.0.1:5173`. Configure the backend's `CORS_ORIGIN` when using a different frontend origin.

| Setting                                          | Meaning                                                                                                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW_PROVIDER=deepagents`                   | Runtime default: real SDK script/scene drafting, each followed by a separately delegated reviewer. Uses server model access and the shared budget.                                           |
| `WORKFLOW_PROVIDER=guided`                       | Explicit offline structured templates; no model account or API key needed. Uploaded photos are used in the actual rendered video, but their visual content is not analyzed by this provider. |
| `WORKFLOW_PROVIDER=openai`                       | Enable model-assisted natural language refinement, image interpretation, script/scene proposals, and queries.                                                                                |
| `OPENAI_API_KEY`                                 | Server model key, also used by Deep Agents unless its override is configured. Never include it in frontend environment variables or requests.                                                |
| `OPENAI_MODEL`                                   | Direct OpenAI model setting; defaults to `gpt-6-luna`. The application budget profile requires this model.                                                                                   |
| `DEEPAGENTS_MODEL` / `DEEPAGENTS_OPENAI_API_KEY` | Agent model and optional key override. The model defaults to `gpt-6-luna`; the key falls back to `OPENAI_API_KEY`.                                                                           |

The direct OpenAI adapter sends attached image bytes as image inputs and uses strict JSON schema outputs through the Responses API. Deep Agents uses this adapter for refinement and queries; its script/scene specialists consume the saved brief, attributed research and creator image descriptions. They do not claim new visual observations from image descriptions. Model suggestions still require creator review; JSON validation is not independent verification of product claims. [Official image input guide](https://developers.openai.com/api/docs/guides/images-vision), [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs), [gpt-6-luna model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).

Each SDK script run delegates a model-authored draft to `script_writer`, then requires `script_reviewer` to read and review its saved artifact. Scene runs use `scene_director` and `scene_reviewer`, preserving exact script timing, segment order and creator asset IDs. Each run allows at most 16 model calls and 32 tool calls, with a default 90-second deadline. No tool can grant creator approval or start video production.

Original generated scripts/scenes retain a server-owned `agentRun` receipt with model, context hash, actual call counts, specialists, cited research IDs/decisions and review summary. Its optional `researchContext` preserves the exact attributed handoff and source URLs independently of later research changes. Research itself can use the SDK to produce evidence-cited model summaries and adopt/avoid/test decisions over immutable collected sources. Research framing stays separate from creator facts and approval.

Choosing `deepagents` or `openai` without a key fails explicitly; use `guided` deliberately for offline work. An unavailable, refused, timed out, rejected or malformed provider response is reported as an error rather than silently replaced with a claimed AI result. Provider tests exercise the actual SDK with deterministic models and mocked transport; a configured account is needed to exercise live model output.

## State, questions, and verification

The response envelope for workflow mutations is:

```ts
type WorkflowResponse = {
  workflow: Workflow;
  verification: {
    brief: StageVerification;
    script: StageVerification;
    scenes: StageVerification;
  };
};

type StageVerification = {
  stage: 'brief' | 'script' | 'scenes';
  state: 'blocked' | 'needs_review' | 'approved';
  canApprove: boolean;
  checks: Array<{
    code: string;
    passed: boolean;
    severity: 'error' | 'warning';
    message: string;
    path?: string;
  }>;
};
```

`workflow.questions` contains stable question IDs/fields: `productName`, `productDescription`, `audience`, `keyBenefits`, `callToAction`, and, when images are attached, `imageDirection`. Show `status: "open"` questions as follow-ups. An open optional follow-up can be a warning rather than a hard blocker; use verification checks to decide what prevents approval instead of treating every question as required.

Brief data includes `productName`, `productDescription`, `audience`, `keyBenefits`, `callToAction`, `imageDirection`, `platform`, `tone`, and `duration`. Platforms are `instagram`, `tiktok`, or `youtube`; duration is `15`, `30`, or `60` seconds; tone is `conversational`, `educational`, or `bold`.

A script has server-issued segment IDs and spoken text with integer durations. Each scene refers to a script segment and attached asset IDs. Verification checks the current source revisions, timing, segment coverage, and references. Approval records refer to the current brief revision and immutable script/scene IDs. Model generation does not create approval records.

Content changes invalidate the affected approvals and downstream work. A changed brief or attached image requires a new current script/scene proposal; editing a script invalidates its scene plan. Previous render jobs remain historical artifacts and must not be presented as a render of newly edited content.

## Version and error handling

Every workflow mutation carries `expectedVersion`. Use the latest returned `workflow.version` for the next request. A stale version returns `409` with `WORKFLOW_VERSION_CONFLICT`; reload the workflow, preserve the local form values for comparison, and let the creator retry. Do not automatically replay a stale approval against changed content.

Creating or polling a render does not increment the workflow version. Each job records the workflow version and scene artifact it renders. Polling and querying are read operations. `/history` exposes saved workflow revisions; it is not an undo operation.

Errors use the existing envelope:

```json
{
  "error": {
    "code": "WORKFLOW_VERSION_CONFLICT",
    "message": "This promo changed while you were editing. Reload before trying again."
  }
}
```

Render jobs have their own failure `error: { code, message }`. The job states are `queued`, `running`, `succeeded`, and `failed`; stop polling at either terminal state. If the server restarts during queued/running work, that job becomes failed with `RENDER_INTERRUPTED` so the client can offer a new render.

## Endpoints

Paths below are relative to `/api/workflows`. IDs are server-issued UUIDs. JSON mutations use `Content-Type: application/json`; photo uploads use raw binary instead.

| Method and path                                 | Request / result                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /`                                        | `{ input, title?, brief? }` → `{ workflow, verification }`                                                              |
| `GET /?q=matcha`                                | Optional text search → `{ workflows }`                                                                                  |
| `GET /:id`                                      | Current `{ workflow, verification }`                                                                                    |
| `POST /:id/refine`                              | `{ expectedVersion, message?, answers?, brief? }`; supply at least one change → updated workflow envelope               |
| `POST /:id/prepare`                             | `{ expectedVersion, regenerate?: false }` → fill missing current proposals; `regenerate: true` explicitly replaces them |
| `POST /:id/approve-all`                         | `{ expectedVersion }` → explicitly approve the current reviewable stages                                                |
| `POST /:id/script/generate`                     | `{ expectedVersion }` → script; detailed path requires current approved brief                                           |
| `PATCH /:id/script`                             | `{ expectedVersion, hook, segments, caption }`; send complete editable script content                                   |
| `POST /:id/scenes/generate`                     | `{ expectedVersion }` → scenes; detailed path requires current approved script                                          |
| `POST /:id/scenes/prepare`                      | `{ expectedVersion }` → proposed scenes for the current script, before creator approval                                 |
| `PATCH /:id/scenes`                             | `{ expectedVersion, scenes }`; send the complete scene array                                                            |
| `POST /:id/approve`                             | `{ expectedVersion, stage: "brief" \| "script" \| "scenes" }`                                                           |
| `GET /:id/verification`                         | Current stage checks                                                                                                    |
| `GET /:id/history`                              | Saved workflow revisions                                                                                                |
| `POST /:id/query`                               | `{ question }` → `{ answer, evidence, openQuestions, workflowVersion, provider }` without a state change                |
| `POST /:id/assets?expectedVersion=N`            | Raw image bytes; matching image `Content-Type` and URL-encoded `X-File-Name` header → updated workflow envelope         |
| `GET /:id/assets/:assetId`                      | Stored image bytes                                                                                                      |
| `PATCH /:id/assets/:assetId`                    | `{ expectedVersion, description }` → updated workflow envelope                                                          |
| `DELETE /:id/assets/:assetId?expectedVersion=N` | Remove an attached image using current version                                                                          |
| `POST /:id/renders`                             | `{ expectedVersion }` → `202 { job }`; requires current approved stages and usable scene photos                         |
| `GET /:id/renders`                              | `{ jobs }`                                                                                                              |
| `GET /:id/renders/:jobId`                       | `{ job }`                                                                                                               |
| `GET /:id/renders/:jobId/video`                 | Completed MP4 for preview                                                                                               |
| `GET /:id/renders/:jobId/video?download=1`      | Completed MP4 attachment                                                                                                |
| `GET /:id/publish`                              | Current completed video and caption hand-off; no social API side effect                                                 |
| `DELETE /:id?expectedVersion=N`                 | Remove the workflow with current version; active renders must finish first                                              |

`GET /:id/verification` returns `{ verification }`. `GET /:id/history` returns `{ history: Workflow[] }`, newest first, with at most 50 saved revisions.

For `answers.keyBenefits`, send text separated by new lines or semicolons. For `brief.keyBenefits`, send an array of strings. `message` accepts natural language; the OpenAI provider can propose extracted brief changes, while guided mode retains the message and uses explicit answers/brief fields for factual content.

The publish hand-off is available only for a succeeded render of the current scene plan:

```ts
type PublishKit = {
  workflowId: string;
  workflowVersion: number;
  platform: 'instagram' | 'tiktok' | 'youtube';
  caption: string;
  script: string;
  video: {
    jobId: string;
    url: string; // API-relative MP4 download URL
    width: 1080;
    height: 1920;
    duration: 15 | 30 | 60;
    hasAudio: false;
  };
  ready: true;
  automaticPosting: false;
};
```

Image uploads accept still PNG, JPEG, and WebP, at most **10 MiB each**, at most **20 images** per workflow, under **40 megapixels** per image, and no dimension over 20,000 pixels. The server decodes the file and verifies the actual image format; renaming a non-image file is insufficient. Source images are addressed through workflow/asset IDs. There is no remote URL ingestion or server-side URL fetch. OpenAI requests additionally limit the combined image data to **20 MiB**, so resize or remove photos if that provider limit is reached.

## Complete frontend integration example

This browser JavaScript uses the Vite `/api` proxy. For a separate deployment, set `API_ORIGIN` to the API origin and configure CORS. `files` is an array of `File` objects from the frontend's file input. Keep the latest returned workflow envelope in frontend state.

```js
const API_ORIGIN = '';
const ROOT = `${API_ORIGIN}/api/workflows`;

async function request(path, options = {}) {
  const response = await fetch(`${ROOT}${path}`, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error?.message ?? `Request failed (${response.status}).`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function json(method, value) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export async function prepareMatchaPromo(files) {
  let state = await request(
    '',
    json('POST', {
      title: 'Mori Matcha weekend promo',
      input:
        'Make a welcoming promo for our neighborhood matcha shop. Show our drinks and invite people to visit this weekend.',
      brief: {
        productName: 'Mori Matcha',
        productDescription:
          'A neighborhood matcha bar serving iced matcha and strawberry matcha drinks.',
        audience: 'People nearby looking for a place to meet friends',
        keyBenefits: ['Iced matcha', 'Strawberry matcha', 'A place to meet friends'],
        callToAction: 'Visit Mori Matcha this weekend.',
        imageDirection: 'Use our supplied drink and shop photos. Keep the product easy to see.',
        platform: 'instagram',
        duration: 15,
        tone: 'conversational',
      },
    }),
  );

  // Upload sequentially: each accepted upload returns a new workflow version.
  for (const file of files) {
    state = await request(
      `/${state.workflow.id}/assets?expectedVersion=${state.workflow.version}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': file.type,
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      },
    );
  }

  state = await request(
    `/${state.workflow.id}/prepare`,
    json('POST', {
      expectedVersion: state.workflow.version,
    }),
  );
  return state; // Show this proposal for review; do not auto-approve here.
}

export async function refinePromo(state, message, answers) {
  return request(
    `/${state.workflow.id}/refine`,
    json('POST', {
      expectedVersion: state.workflow.version,
      ...(message ? { message } : {}),
      ...(answers ? { answers } : {}),
    }),
  );
}

export async function askAboutPromo(workflowId, question) {
  return request(`/${workflowId}/query`, json('POST', { question }));
}

export async function getPublishKit(workflowId) {
  return request(`/${workflowId}/publish`);
}

export async function approveAndRender(state, signal) {
  // Call this only from the creator's explicit review/approval action.
  const approved = await request(
    `/${state.workflow.id}/approve-all`,
    json('POST', {
      expectedVersion: state.workflow.version,
    }),
  );
  const { job } = await request(
    `/${approved.workflow.id}/renders`,
    json('POST', {
      expectedVersion: approved.workflow.version,
    }),
  );
  return { state: approved, job: await waitForRender(approved.workflow.id, job.id, signal) };
}

export async function waitForRender(workflowId, jobId, signal) {
  // Bound polling to six minutes. Stop on a terminal result or user cancellation.
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const { job } = await request(`/${workflowId}/renders/${jobId}`, { signal });
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') {
      const error = new Error(job.error?.message ?? 'The promo could not be rendered.');
      error.code = job.error?.code;
      throw error;
    }
    await new Promise((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Polling canceled.', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', aborted);
        resolve();
      }, 1500);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  throw new Error(
    'The render is still processing. Refresh its status rather than starting a duplicate render.',
  );
}

export function completedVideoUrl(workflowId, jobId, download = false) {
  return `${ROOT}/${workflowId}/renders/${jobId}/video${download ? '?download=1' : ''}`;
}
```

After `waitForRender` returns successfully, use `completedVideoUrl(...)` as the `<video controls>` source or download link. The current script caption is available as `state.workflow.script.caption`; `/publish` can supply the current publish hand-off. Canceling browser polling does not cancel the server-side render.

For query results, display the response as a workflow-grounded answer with its evidence references and open questions. A query cannot change the brief, approve copy, or start a render. Offer a separate refinement action if the creator wants to apply a suggested direction.

## Integration boundaries

- Use `@yap/contracts/workflow` and `@yap/contracts/render` to validate frontend responses. Do not import implementation files from `apps/api`.
- Keep model credentials and file system paths on the backend. The browser uploads bytes and receives scoped asset/video URLs.
- This implementation uses one API process, a persistent JSON store, and local asset/render files. It is suitable for the current local workspace; multiuser identity, tenant isolation, distributed queues, and shared object storage are separate deployment work.
- A completed historical render is immutable. When the workflow changes, prepare/review/render the new current version before offering it as the current promo.
- Automated checks cover the workflow, provider adapter, image validation, and rendering. Live provider quality depends on the configured model/account and must be exercised separately.
