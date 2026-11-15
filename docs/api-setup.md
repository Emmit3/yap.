# Connecting the creator APIs

The configuration template selects **fal.ai MiniMax H3 Max** for image-first animation, with **OpenAI gpt-6-luna** for required visual review. The Visual studio uses direct GPT Image 2.6 generation/editing; the existing Seedance 1.5 Pro path remains available. Firecrawl adds live public research. The adapters are covered by injected HTTP tests; live credentials, account entitlement, generated quality, and provider invoices are not established by those tests. See [image versions and animation](creator-keyframes.md) for the connected workflow and image-cost controls.

## Required accounts and settings

| Service                                                                         | What it enables                                                              | Server setting                                                                |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [fal.ai H3 Max](https://fal.ai/models/minimax/h3-max/image-to-video)            | Image-first animation from a selected frame; silent app output               | `FAL_KEY`, `CREATOR_VIDEO_PROVIDER=fal`, `CREATOR_VIDEO_MODEL=minimax-h3-max` |
| [OpenAI images](https://developers.openai.com/api/docs/guides/image-generation) | Portrait image creation, editing and saved versions                          | `OPENAI_API_KEY`; model and quality selected in Visual studio                 |
| [OpenAI API](https://developers.openai.com/api/docs/models/gpt-6-luna)          | Required sampled-frame review; optional editable script/photo interpretation | `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-6-luna`                                   |
| [Firecrawl](https://www.firecrawl.dev/pricing)                                  | Optional live cinematography and indexed X/TikTok/Instagram discovery        | `FIRECRAWL_API_KEY`                                                           |
| LangChain Deep Agents                                                           | Optional real SDK evidence review using the configured OpenAI account        | `DEEPAGENTS_MODEL=gpt-6-luna`; no separate LangChain key                      |

Use a user-owned API key with access to the selected model. A consumer video subscription or a connected chat plugin does not establish API access for this server. Higgsfield is a separate developer service and is **not an implemented video adapter** here. No X, Meta, AWS, or Higgsfield account is required for the selected stack.

## Local configuration

1. Copy [the API template](../apps/api/.env.example) to `apps/api/.env` if that file does not already exist. Preserve existing private settings.
2. Add keys only to that ignored server file or the API process environment. Never use `VITE_` variables for secrets, commit keys, or paste them into public chat.
3. Keep the selected settings below. To enable model-driven script interpretation, change `WORKFLOW_PROVIDER` from `guided` to `openai` after adding the OpenAI key.
4. Restart the API after changing environment settings. Run `npm ci` and `npm run dev` from the repository root for the normal local application at `http://127.0.0.1:5173`.

```dotenv
CREATOR_VIDEO_PROVIDER=fal
CREATOR_VIDEO_MODEL=minimax-h3-max
FAL_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-luna
FIRECRAWL_API_KEY=
DEEPAGENTS_MODEL=
CREATOR_BUDGET_LIMIT_USD=30.00
WORKFLOW_PROVIDER=guided
```

Set `DEEPAGENTS_MODEL=gpt-6-luna` to enable the optional real evidence-review harness. The current spending profile permits only this model for text and research requests; another model, including Terra, is rejected before paid dispatch. Its research-specific `DEEPAGENTS_OPENAI_API_KEY` can override the shared OpenAI key. Leave optional `X_BEARER_TOKEN` and `XAI_API_KEY` empty for this budget setup: those separate providers are outside the selected USD reservation profile.

`GET /api/creator/capabilities`, `/api/social/providers`, and `/api/social/research-runs/capabilities` report configuration presence without exposing secrets. Presence is not proof of a valid key, sufficient balance, or successful live generation. `GET /api/creator/budget` reports the durable app budget.

After starting the app, run `npm run check:connections` for a read-only readiness report. Use `npm run check:connections -- --url=http://127.0.0.1:3002 --json` for another API port and structured output. The command never starts paid work or reads provider secrets.

Without external keys, guided preparation, the existing photo renderer, and labeled synthetic research replay remain available. Missing or failed live providers do not become fabricated research or generated footage.

## Keeping the experiment below USD 35

The default app cap is **USD 30**, leaving USD 5 outside the app for checkout charges, pricing differences, or other use. It can be lowered with `CREATOR_BUDGET_LIMIT_USD`, never raised above 30. Use small prepaid balances where supported and disable provider auto-recharge. Provider balances, purchases, taxes, and activity using the same keys elsewhere remain your responsibility; the local ledger is not an account-wide billing limit.

The H3 Max app profile reserves **USD 0.10 per generated second plus USD 0.10 for each new clip's review**: three five-second shots reserve USD 1.80. It uses regular pricing rather than an expiring promotion. Each image creation/editing job separately reserves a conservative USD 2, settled when valid usage is available. These are app estimates, not guaranteed invoice ceilings. [Image cost and recovery details](creator-keyframes.md).

For the existing Seedance path, the [fal model page](https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video) lists silent output at USD 1.20 per million video tokens, with an approximately USD 0.13 example for five seconds at 720p. The app's selected Seedance profile reserves USD 0.05 per clip-second plus the USD 0.10 review allowance; three five-second clips reserve USD 1.05.

OpenAI text/vision requests use the budget model with bounded output and Standard service. Each such request reserves USD 0.50 before dispatch; known returned usage can settle this conservative allowance, while unknown outcomes retain it. Research reserves each model/search request separately, so parallel agent branches cannot hide extra spending inside a batch estimate. Quote-reserved visual audits use their existing per-clip hold. Direct X/Grok requests and paid built-in model tools are disabled in this budget profile. Free Firecrawl credits may cover discovery: the [current free plan](https://www.firecrawl.dev/pricing) lists 1,000 credits per month. Avoid enabling paid automatic top-ups for this experiment.

Before production, request and inspect the exact cost quote, explicitly approve its current plan and cost, then produce. Quotes expire after ten minutes. Failed visual review never automatically starts another paid generation. A deliberate retry needs a fresh quote and explicit approval, with a maximum of two paid attempts per clip for the same plan. Reapproving an unchanged plan does not reset that limit. Passed clips can be reused after integrity verification.

Unknown submissions, disconnects, and unconfirmed cancellation keep their cost holds. Cancellation may stop local work while the remote provider continues and bills. Do not delete budget data to regain headroom: storage contains the durable reservations and attempt history.

## Optional Runway alternative

Set `CREATOR_VIDEO_PROVIDER=runway` and `RUNWAYML_API_SECRET` to select the existing Gen-4.5 adapter explicitly. OpenAI visual review is still required. The [official Runway price table](https://docs.dev.runwayml.com/guides/pricing/) lists 12 credits per second at USD 0.01 per credit, or USD 0.12 per second. The app conservatively quotes USD 0.16 per second plus the same per-clip review allowance. Provider failures never silently switch to another paid service.

Prices and model documentation were checked on November 14, 2026. Confirm the selected account's current rate and entitlement before funding or generating. No purchase or paid live generation was performed during implementation.
