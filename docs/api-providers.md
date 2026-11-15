# API providers and configuration

The configuration format is published in the root [`.env.example`](../.env.example).
Copy it to the root `.env` or `apps/api/.env` and fill in only the services you
want to use. API commands load the optional root `.env` first, then
`apps/api/.env`; existing process environment values take precedence.
Restart the API after editing either file.

With `WORKFLOW_PROVIDER=guided`, offline photo preparation, photo-to-MP4 rendering, and labeled synthetic research
replay work without external keys. Generated video and live research require the
configured services below. [API setup and budget controls](api-setup.md) explains
the selected stack in detail.

## Available integrations

| Integration                       | Implemented use                                                                                        | Server configuration                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fal.ai                            | Silent Seedance 2.5 generated clips, with native portrait/landscape 720p profiles                      | `CREATOR_VIDEO_PROVIDER=fal`, `CREATOR_VIDEO_MODEL=seedance-2.5`, `FAL_KEY`, and `OPENAI_API_KEY` for required visual review                                      |
| OpenAI Responses                  | Required generated-clip frame review; optional text/photo interpretation and editable script proposals | `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-6-luna`; set `WORKFLOW_PROVIDER=openai` for interpretation                                                                    |
| Firecrawl Search                  | Live public web and indexed social discovery                                                           | `FIRECRAWL_API_KEY`                                                                                                                                               |
| LangChain Deep Agents with OpenAI | Real SDK research planning/delegation and separate script/scene drafting specialists                   | `WORKFLOW_PROVIDER=deepagents`, `DEEPAGENTS_MODEL=gpt-6-luna`, plus `DEEPAGENTS_OPENAI_API_KEY` or fallback `OPENAI_API_KEY`; also needs a public-source provider |
| Runway (historical, unselected)   | Retained legacy adapter and records                                                                    | Not part of the current fal setup; never selected as a default or automatic fallback                                                                              |
| AWS S3                            | Optional command to upload a finished MP4 and create a temporary download link                         | `AWS_REGION`, `AWS_S3_BUCKET`, optional `AWS_S3_PREFIX`, and standard AWS credentials                                                                             |

Direct X and Grok adapters are **disabled in the current budget profile**.
Adding `X_BEARER_TOKEN` or `XAI_API_KEY` does not enable them; leave those keys
empty for this setup. Firecrawl discovers indexed public X/TikTok/Instagram
material. It does not connect a private social account or provide complete
platform coverage. See [social research](social-analysis.md).

## Configure the creator studio

Set these values in `apps/api/.env`, replacing the key placeholders:

```dotenv
CREATOR_VIDEO_PROVIDER=fal
CREATOR_VIDEO_MODEL=seedance-2.5
FAL_KEY=replace-with-your-fal-key
OPENAI_API_KEY=replace-with-your-openai-key
OPENAI_MODEL=gpt-6-luna
CREATOR_BUDGET_LIMIT_USD=30.00
WORKFLOW_PROVIDER=deepagents
DEEPAGENTS_MODEL=gpt-6-luna
FIRECRAWL_API_KEY=replace-with-your-firecrawl-key
```

Use `WORKFLOW_PROVIDER=deepagents` for actual SDK script/scene work. Refinement and questions delegate to the existing OpenAI adapter. Select `guided` for offline templates or `openai` for direct model drafting.
Generated clips still require exact quote approval and visual review. The
durable app reservation cap can be lowered through `CREATOR_BUDGET_LIMIT_USD`,
but cannot exceed 30. It does not limit an entire provider account's billing.
There is no automatic paid provider fallback.

New video generation uses fal Seedance 2.5. Seedance 1.5 Pro is retired and
cannot start new generation; change an old explicit retired profile and review
a new quote. A Runway key alone never adds Runway choices to the fal registry.

For live public discovery, add `FIRECRAWL_API_KEY`. The agent model defaults to
`gpt-6-luna`; with model and public-source access configured, analytics defaults
to the real Deep Agents engine. Creator research also uses the configured SDK, with model-authored synthesis and validated source IDs. Script/scene receipts retain those cited IDs. Leave
`DEEPAGENTS_OPENAI_API_KEY` empty to reuse `OPENAI_API_KEY`; no separate
LangChain API key is required. See [the Deep Agents guide](deepagents-demo.md).

## Run and check connections

From the repository root:

```sh
npm ci
npm run dev
```

In another terminal, run `npm run check:connections` for a read-only readiness
report. Configuration presence is not proof of valid credentials, provider
balance, or successful live generation. No paid work starts from that check.

For AWS export, follow the [S3 setup guide](aws-s3.md). The explicit
`npm run aws:upload -- ./data/videos/RENDER_ID.mp4` command uses an existing private
bucket and the SDK's normal local profile or IAM role credentials. Storage stays
local unless you run the upload command. AWS usage is separate from the creator
production budget.

## Frontend settings

Copy `apps/web/.env.example` to `apps/web/.env`. Leave `VITE_API_BASE_URL` empty
for the local proxy. `VITE_` variables are public browser configuration; keep
provider keys in the API environment. Connected chat plugins do not supply keys
to the running app. Automatic social publishing, Bedrock, and Polly voiceover
remain future integrations.
