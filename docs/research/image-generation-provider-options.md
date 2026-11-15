# Image-generation provider options for Yap

Checked 2026-11-14 against official provider documentation. This is a proposed integration comparison, not proof of live account access or a quality benchmark. Gorm's model label is a separate observation from verification of its server-side provider.

## Recommendation

Add an explicit **storyboard image generation and editing stage** before paid video generation. Start with direct OpenAI GPT Image because Yap already has an OpenAI server integration/authentication path and Gorm publicly labels its image workflow with that model family. Reuse fal for video; evaluate an image model through fal as an alternative after the first storyboard flow works. Higgsfield is a real API option, but it is a separate provider integration, not a prerequisite for reproducing a useful studio workflow.

Preserve Yap's source ownership, versioned approval, exact quotes, durable spend reservations and explicit retry rules. A generated storyboard must remain labeled generated material, not the creator's original photo or an independently verified product fact.

## Direct OpenAI image API

`gpt-image-2.6-flare` is a documented image-generation/editing model, described for fast iteration; `gpt-image-2.6-sunburst` is its detailed-visual-work counterpart. The existence of the official model does not establish that a third-party website calls OpenAI directly. [Flare model](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare), [image guide](https://developers.openai.com/api/docs/guides/image-generation).

Use `POST /v1/images/generations` to create a frame, and `POST /v1/images/edits` to revise it using text and approved references. The edit API explicitly lists the 2.6 model IDs and accepts up to 16 image references using image URLs/data or uploaded File IDs. Validate parameters for the selected model rather than copying older examples' fidelity controls. [Edit API](https://developers.openai.com/api/reference/resources/images/methods/edit/).

OpenAI also supports an image-generation tool in a conversational Responses flow. For Yap's first version, discrete image jobs make quotes, lineage and revisions easier to audit. The guide's existing examples mostly use 2.5 even though it contains an explicit 2.6 section; choose the API/model combination from current documentation. Some accounts may require API organization verification. These are developer API calls using the server's API account, not automation of the ChatGPT website. [Image guide](https://developers.openai.com/api/docs/guides/image-generation).

## Image model through existing fal integration

A concrete alternative is `google/nano-banana-2.1/edit`. fal documents reference-image inputs, prompt-based edits, PNG/JPEG/WebP output, aspect-ratio controls including portrait, and 1K/2K/4K options. It uses `FAL_KEY` and the same submit/status/result queue pattern already used by Yap's video adapter. Model-specific inputs and pricing still need their own validation and pricebook entry; a shared API key does not make the adapter interchangeable. [Official model/API schema](https://fal.ai/models/google/nano-banana-2.1/edit/api).

**Tradeoff:** this minimizes new authentication/provider lifecycle work, while direct OpenAI more closely matches the image model label observed in Gorm. Neither provider has been quality-tested against the same Yap brief here; compare consistency, prompt adherence, latency and cost on an approved small test set.

## Higgsfield is another API option

Higgsfield has an official asynchronous generative-media API and Python/TypeScript SDK guidance. Its examples include SOUL V2 image generation at `POST https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard` and Genjutsu motion transfer at `POST https://api.higgsfield.ai/higgsfield/genjutsu/motion-transfer/v1.0`. Authentication uses an API key ID/secret pair in `Authorization: Key ID:SECRET`. Check the API Console's model entitlement; a consumer UI feature or subscription is not itself an API contract. [API overview](https://docs.higgsfield.ai/docs).

Generation returns a stable `request_id` and operation URLs. States are `queued`, `in_progress`, `completed`, `failed`, `nsfw` and `canceled`. Persist accepted requests, use their returned operation links, and preserve idempotency keys across uncertain submissions. Only queued work can be canceled. Finished output must be copied into application storage before provider retention expires. [Request lifecycle](https://docs.higgsfield.ai/docs/concepts/requests).

Higgsfield offers an authenticated, model-specific `/estimate/...` endpoint before generation; the returned account estimate is authoritative, not the example amount in documentation. Failed/moderated requests are not charged, and canceled queued requests are refunded. Its account balance and retention rules are separate integration considerations. [Billing and retention](https://docs.higgsfield.ai/docs/concepts/billing-and-retention).

Its catalog documents image and video model families, but availability is account-specific. This research does **not** establish that Gorm uses Higgsfield, or that every model offered on Higgsfield's consumer site is callable through its public API. [API model catalog](https://docs.higgsfield.ai/docs/models).

## Video upgrade: MiniMax H3 Max without a provider rewrite

H3 Max is a documented API model, not only a label seen in Gorm. AtlasCloud exposes `minimax/h3-max/image-to-video` (plus text/reference variants): `POST https://api.atlascloud.ai/api/v1/model/generateVideo` returns a prediction ID; `GET /api/v1/model/prediction/{id}` returns processing/completed/succeeded/failed state and output URLs. It uses a server-side `ATLASCLOUD_API_KEY` Bearer token. Its current image-to-video schema permits **5-15 seconds**, native 480P/768P, and optional first/last frames; this differs from Gorm's displayed 3-15-second range. Validate provider schemas rather than copying UI ranges. [AtlasCloud API/model page](https://www.atlascloud.ai/models/minimax/h3-max/image-to-video).

Yap can instead keep `FAL_KEY`: fal documents `minimax/h3-max/image-to-video` and `minimax/h3-max/text-to-video`. Its image endpoint includes first/end-frame URLs, 480P/768P/1080P output and optional `target_audio_url`. The model family supports synchronized audio; fal describes its model as a fal-post-trained MiniMax H3 variant, so identical names across hosts do not prove identical output or behavior. [Image-to-video schema](https://fal.ai/models/minimax/h3-max/image-to-video/api), [model overview](https://fal.ai/minimax-h3-max).

Submit to `https://queue.fal.run/minimax/h3-max/image-to-video` with `Authorization: Key FAL_KEY`, persist `request_id`, and use the returned status/result/cancel URLs. The queue states are IN_QUEUE, IN_PROGRESS and COMPLETED; completion can also contain an error. Operation URLs use owner/app paths, not the full endpoint path. [Queue API](https://fal.ai/docs/documentation/model-apis/inference/queue).

**Recommendation:** evaluate the fal H3 Max adapter against the same approved brief as Seedance before adding another account. It still needs model-specific timing/output validation and prices in Yap's quote system. To benefit from generated sound, change audio handling and final audit explicitly: Yap's present silent normalizer would discard it. No quality comparison or paid generation was run. AtlasCloud remains a valid separate adapter if its results, model availability or commercial terms justify it; Gorm's public disclosure does not reveal its exact server mapping.

Direct MiniMax is another documented route: `POST https://api.minimax.io/v2/video_generation`, `model: MiniMax-H3-Max`; poll `GET /v2/query/video_generation/{task_id}`. Its documented Max constraints are 480P/768P and 5-15 seconds, with multimodal reference inputs. [Create task](https://platform.minimax.io/docs/api-reference/video-generation-v2-create), [query task](https://platform.minimax.io/docs/api-reference/video-generation-v2-query).

## Proposed integration shape

1. Add typed `generateStoryboardImage` and `editStoryboardImage` jobs with explicit source asset IDs, prompt, model, output settings, parent image version and cost quote.
2. Extend Yap's paid-request allowlist and pricebook deliberately. Current OpenAI budget policy accepts only its bounded text/vision model and rejects image endpoints/built-in paid tools; adding a key alone cannot enable this capability.
3. Save generated variants in an asset library with immutable provider/request/model/prompt/input hashes. Let the creator select and approve a frame before spending on animation.
4. Feed the selected frame to the existing fal image-to-video path; retain manual retries and the existing technical/vision checks. Reuse passed clips instead of regenerating the whole film.
5. Add narration/music/sound and timeline operations as separate later adapters, with separate quotes and audio-aware final validation. Current silent assembly is not an audio editor.

No paid generation, account sign-in, credential inspection, API implementation, branch creation or push was performed for this research.
