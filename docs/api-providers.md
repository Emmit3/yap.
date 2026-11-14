# API providers and local configuration

Yap runs locally without paid API access. The guided provider prepares editable
promo copy, and FFmpeg renders uploaded photos into an MP4. Example research is
explicitly synthetic and makes no provider calls.

Configuration belongs in `apps/api/.env`. The API workspace loads that file when
started with `npm run dev:api` or `npm run dev` from the repository root. Restart
the API after changing it. Copy the root [`.env.example`](../.env.example)
to `apps/api/.env`; the format is also available in
[`apps/api/.env.example`](../apps/api/.env.example). Templates contain no actual keys.

## Available integrations

| Integration                       | Implemented use                                                                                               | Server environment variables                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| OpenAI Responses                  | Interpret text and uploaded images; propose briefs, scripts and scenes; answer workflow questions             | `WORKFLOW_PROVIDER=openai`, `OPENAI_API_KEY`, optional `OPENAI_MODEL`    |
| Firecrawl Search                  | Find public web pages and indexed X/Instagram links                                                           | `FIRECRAWL_API_KEY`                                                      |
| X API recent search               | Retrieve a sample of public posts with returned metrics and interaction references                            | `X_BEARER_TOKEN`                                                         |
| xAI Responses X search            | Discover public X sources through citations                                                                   | `XAI_API_KEY`, optional `XAI_MODEL`                                      |
| LangChain Deep Agents with OpenAI | Coordinate source research, network analysis and creative strategy using the configured public-data providers | `DEEPAGENTS_MODEL`, plus `DEEPAGENTS_OPENAI_API_KEY` or `OPENAI_API_KEY` |

Firecrawl's Instagram path discovers indexed public material; it is not an
Instagram account connection. X collection samples one recent-search page and
at most seven days. xAI citations do not provide verified engagement counts.
See [social research](social-analysis.md) for collection limits.

## Start without keys

Keep this setting in `apps/api/.env`, leaving provider keys empty:

```dotenv
WORKFLOW_PROVIDER=guided
```

From the repository root:

```sh
npm ci
npm run dev
```

Use example research to explore the research interface without external access.

## Enable OpenAI promo assistance

Update these values in `apps/api/.env`:

```dotenv
WORKFLOW_PROVIDER=openai
OPENAI_API_KEY=replace-with-your-server-key
OPENAI_MODEL=replace-with-a-supported-text-and-image-model-id
```

Choose a model available to your account that supports image inputs and
structured outputs. These settings affect the promo workflow; they do not
automatically enable agent research. Proposals still require creator approval
before rendering. See [the promo guide](promo-backend.md).

## Enable Deep Agents research

Add an OpenAI model and a public search provider to `apps/api/.env`:

```dotenv
FIRECRAWL_API_KEY=replace-with-your-firecrawl-key
DEEPAGENTS_MODEL=replace-with-a-supported-openai-tool-calling-model-id
DEEPAGENTS_OPENAI_API_KEY=replace-with-your-server-key
```

The research-specific key can be left empty to reuse `OPENAI_API_KEY`.
`WORKFLOW_PROVIDER` may remain `guided`. This adapter supports OpenAI models;
other model providers need an adapter change. Select live research and the
Deep Agents harness; the pipeline remains the default harness. For API clients,
send `mode: "live"` and `harness: "deepagents"` to
`POST /api/social/research-runs` with a topic and selected platforms.

Check `GET /api/social/providers` and
`GET /api/social/research-runs/capabilities` for configuration presence. These
endpoints do not authenticate keys or prove account access. See
[the Deep Agents guide](deepagents-demo.md) for run requests and polling.

## Frontend settings and future additions

`apps/web/.env` only needs `VITE_API_BASE_URL`; leave it empty for the local proxy.
`VITE_` variables are public browser configuration. Keep provider credentials in
the API environment. Connected chat plugins do not supply application API keys.

Amazon Bedrock, Amazon Polly voiceover, and automatic Instagram/social publishing
are possible future integrations; they are not connected in this application.
