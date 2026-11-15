# Connecting the creator APIs

Use **fal Seedance 2.5** for new video generation, with **OpenAI gpt-6-luna** for required sampled-frame review. Firecrawl adds optional live public research. The current video path uses fal only. [Seedance 1.5 Pro was retired on November 11, 2026](https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video); its historical Yap profile remains unavailable. No provider error automatically selects a replacement or retries a paid submission.

## Accounts and settings

| Service                                               | What it enables                                                                                                   | Server setting                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [fal Seedance 2.5](https://fal.ai/seedance-2.5)       | Text-to-video or image-to-video clips, with portrait/landscape 720p profiles                                      | `CREATOR_VIDEO_PROVIDER=fal`, `CREATOR_VIDEO_MODEL=seedance-2.5`, `FAL_KEY`  |
| [OpenAI API](https://developers.openai.com/api/docs/) | Required frame review; optional script interpretation, narration, storyboard frames and reference-sample analysis | `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-6-luna` for the bounded text/vision path |
| [Firecrawl](https://www.firecrawl.dev/)               | Optional public cinematography and indexed X/TikTok/Instagram discovery                                           | `FIRECRAWL_API_KEY`                                                          |
| LangChain Deep Agents                                 | Optional SDK evidence review using the configured OpenAI account                                                  | `DEEPAGENTS_MODEL=gpt-6-luna`; no separate LangChain key                     |

Use user-owned API keys with usable model access and credits. A ChatGPT subscription, connected chat plugin or Higgsfield unlimited website plan does not establish fal/OpenAI API access for this server. Yap has no Higgsfield video adapter. No X, Meta, AWS or Higgsfield account is required for this setup. Runway settings are historical; current active video profiles use fal.

## Local configuration

1. Copy [the root `.env.example`](../.env.example) to an ignored root `.env` or `apps/api/.env` if neither already exists. Preserve existing private settings.
2. API commands load root `.env` first, then `apps/api/.env`; existing process environment values take precedence. Keys belong only in these ignored server files or the API process environment. Never use `VITE_` variables for secrets, commit keys or paste them into public chat.
3. Select `fal` and `seedance-2.5` explicitly as below; they are also the defaults when omitted. The active model is Seedance 2.5, not the retired 1.5 model. Old explicit retired profiles must be changed and requoted before generation.
4. Restart after configuration changes. Run `npm ci` and `npm run dev` from the repository root for the local app at `http://127.0.0.1:5173`. Keep `WORKFLOW_PROVIDER=guided` unless you intend to enable configured model-driven drafting.

```dotenv
CREATOR_VIDEO_PROVIDER=fal
CREATOR_VIDEO_MODEL=seedance-2.5
FAL_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-luna
FIRECRAWL_API_KEY=
DEEPAGENTS_MODEL=
CREATOR_BUDGET_LIMIT_USD=30.00
WORKFLOW_PROVIDER=guided
```

Set `DEEPAGENTS_MODEL=gpt-6-luna` to enable the research harness. `DEEPAGENTS_OPENAI_API_KEY` can override its shared OpenAI key. Direct X/Grok calls remain outside this budget profile.

After starting the current API, run `npm run check:connections`. For another port use `npm run check:connections -- --url=http://127.0.0.1:3002 --json`. The command makes readiness GETs only. `/api/creator/capabilities` lists configuration and per-shot video profiles; `/api/social/providers` and `/api/social/research-runs/capabilities` report source/harness settings. Presence does not prove authentication, entitlement, balance or output quality. `/api/creator/budget` reports durable app accounting.

Without provider keys, guided preparation, the photo renderer, the [Mori Drinks demo seed](demo-presenter.md), workspace brand settings, free edits of an existing authorized film, supplied reference imports and labeled synthetic research remain available. Missing live providers do not become fabricated footage or research.

## Shot profiles and final output

Each shot may use the current default or select `fal-seedance2.5-portrait` (720 × 1280) or `fal-seedance2.5-landscape` (1280 × 720). Yap accepts whole shot durations of **4–10 seconds**, a bounded subset of the provider's 4–30-second range. An uploaded photo or explicitly selected generated keyframe enables image-to-video; a shot without an image uses text-to-video. Both request native 720p, H.264, standard bitrate, no draft and no generated audio. The provider charges the same whether its audio toggle is on or off. New production verifies the approved profile's decoded dimensions.

The final `outputProfileId` selects native-size portrait 720p, native-size landscape 720p, or portrait 1080p explicitly labeled as resized from 720p. Historical omitted output choices retain portrait 1080p delivery. Mixing source orientations can require cropping/resizing; the output receipt reports resizing rather than claiming recovered source detail. Profile changes require saving the plan and reviewing a fresh quote. Provider errors never trigger a switch to another paid model.

## Costs and exact approvals

The shared app cap defaults to **USD 30** and can be lowered with `CREATOR_BUDGET_LIMIT_USD`, never raised above 30. Reservations count immediately. Provider purchases, taxes, recharge settings and other uses of the same keys remain outside this local ledger. Keep the data file: deleting it forgets recorded spending rather than refunding provider charges.

[fal's Seedance 2.5 pricing](https://fal.ai/learn/tools/how-to-access-seedance-2-5-on-fal) uses USD 0.0214 per 1,000 output tokens at 720p. Its formula is `width × height × seconds × 24 / 1024` tokens for text/image-to-video. At 720 × 1280 or 1280 × 720, that estimates **USD 0.46224 per second**, or **about USD 9.24 for 20 seconds** of video. Yap reserves a conservative **USD 0.50 per generated second**, plus **USD 0.10 sampled-frame review per new clip**. Four five-second shots therefore have a **USD 10.40 video/review ceiling**, before optional narration. These are estimates and app ceilings, not invoices; verify current account access and pricing before generation.

Before producing video, review the exact current quote and explicitly approve its plan and cost. Quotes expire after ten minutes. Manual retries require another quote/approval and remain limited to two attempts per clip for the same plan. Reapproving an unchanged plan does not renew attempts. Passed clips can be reused only after integrity verification.

Optional narration reserves USD 0.10 per approved spoken segment. Bundled music and subtitle rendering add no provider charge. Ordinary bounded OpenAI text/vision calls reserve USD 0.50 each; known returned usage can settle an estimate, while uncertain outcomes retain their hold. Research/search dispatches have their own bounded reservations. Quote-reserved clip audits use their existing per-clip allowance.

Storyboard generation has a **separate USD 0.10 quote and approval** for one medium 1024 × 1536 PNG using the app's pinned `gpt-image-2-2026-04-21` profile. The [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation) lists GPT Image 2 medium portrait output at about USD 0.041 before text input; the app bounds prompts and keeps headroom in its ceiling. Selecting an earlier frame records lineage, not image-conditioned editing. ChatGPT's built-in image tool and subscription billing are separate.

Reference-sample analysis requires explicit review of a **USD 0.50 ceiling** and the current transcript/frame hash. Importing a transcript or saving a manual note itself starts no model call. Unknown submissions and unconfirmed cancellations keep conservative holds. Nothing automatically retries a failed paid request.

## Production tools and verification

- [Brand settings and timeline editing](creator-brand-edit.md): versioned workspace logos/colours/fonts, explicit film snapshots, reviewed free edits and receipt-checked downloads. Edits slice the existing final film; its original SRT is not recomputed for the edited timeline.
- [Storyboard and reference analysis](creator-reference-assets.md): generated image provenance, manual attempt bounds, timed transcript imports and up to eight explicitly supplied sample frames. Source URLs are attribution and are never fetched by these tools.
- [Creator backend](creator-backend.md): audio, subtitles, exact approval and API/storage boundaries.
- [Presenter path](demo-presenter.md) and [fallback runbook](demo-runbook.md): fictional seed data, live readiness and snapshot handling.

Local FFmpeg fixtures and injected providers exercise the pipeline without paid calls. Two local offline-speech/photo rehearsals do not establish live Seedance, OpenAI narration/image access, provider invoices or the real-provider D4 acceptance in issue #6. Those still require usable funded access, exact approved runs and recorded output/cost review.

Official API/pricing references above were rechecked on November 15, 2026. The [text-to-video API](https://fal.ai/models/bytedance/seedance-2.5/text-to-video/api), [image-to-video API](https://fal.ai/models/bytedance/seedance-2.5/image-to-video/api) and [queue guide](https://fal.ai/docs/documentation/model-apis/inference/queue) describe current request and transport details.
