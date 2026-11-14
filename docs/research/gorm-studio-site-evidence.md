# Gorm Studio: public site and tool-call evidence

Observed November 14, 2026. This records the deployed public website, not an authenticated production run or a backend source audit. No account was created, no generation was started, and no video/audio file was downloaded. The embedded video's transcript is handled separately.

## What is directly supported

| Layer                 | Evidence                                                                                              | Confidence and limit                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web application       | Next.js App Router assets, React client state, utility-style CSS classes, same-origin API routes      | Directly observable in the [landing](https://studio.gormtheold.net/) and its delivered assets; hosting vendor and server implementation are not exposed                                                   |
| Images                | Studio displays GPT Image 2.6 Flare and supports prompts, image references, size and quality controls | Direct [public UI](https://studio.gormtheold.net/toolbox/gorm-studio); the exact upstream model mapping is not verified                                                                                   |
| Image animation       | Client labels the animation tool MiniMax H3 Max, 768p, with audio; durations run from 3 to 15 seconds | Directly observable in the [studio client bundle](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js); no live output was tested                          |
| Character replacement | Scene video plus up to four character photos; quality/cost review; restore previous inputs            | [Public Character Swap page](https://studio.gormtheold.net/toolbox/character-swap); provider disclosed separately                                                                                         |
| Legacy workflows      | Style presets, prompt preview, image generation, image animation, saved history                       | [Legacy Image Generator](https://studio.gormtheold.net/toolbox/image-studio) and its [client bundle](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/image-studio/page-161dfc9105dab57c.js) |

The studio's model name is presented as an output label, rather than a client-side model selector. The image start request does not send an upstream model ID. Treat the displayed name as a product configuration claim until an official provider model definition or a server-side trace establishes the mapping. [Studio client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js).

## First-party infrastructure disclosures

The site's [privacy policy](https://studio.gormtheold.net/privacy), updated November 14, names these processors:

- Supabase for account, database and access state.
- Stripe for payments and subscriptions.
- Cloudflare/R2 for media storage, delivery and edge protection.
- OpenAI for text and image requests.
- AtlasCloud, or a replacement video provider, for video requests.
- fal.ai and its model providers, including MiniMax for Character Swap.

These are the operator's current disclosures. They establish declared service relationships, but not which upstream endpoint handled any particular generation. In particular, the policy's generic AtlasCloud disclosure does not prove that every animation currently routes through AtlasCloud. There is no public evidence from the inspected routes that Higgsfield is part of this deployed stack. That is an evidence gap, not a claim that it has never been used.

## How the visible tools are called

The public client is a conventional browser-to-application API workflow. It does not expose a general LLM tool registry or prove an agent chooses production tools. A server-side agent could exist behind these routes; its implementation is not public.

| User operation            | Browser contract observed                                                                                                       | Source                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Generate or edit an image | POST /api/gorm-studio/generate, JSON with action, requestId, mode, prompt, settings, references, maxCredits                     | [Studio client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js)            |
| Animate a chosen still    | POST /api/gorm-studio/animate, JSON with action, requestId, sourceImageUrl, motionPrompt, durationSeconds, sound and maxCredits | [Studio client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js)            |
| Recover unfinished work   | Same generation route, action=status with jobId or action=pending                                                               | [Studio client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js)            |
| View saved assets         | GET /api/gorm-studio/history; media through /api/gorm-studio/history/media?fileId=...                                           | [Studio client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js)            |
| Remove a saved generation | DELETE /api/gorm-studio/history?fileId=...                                                                                      | [Legacy client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/image-studio/page-161dfc9105dab57c.js)           |
| Inspect credits           | GET /api/gorm-studio/credits                                                                                                    | [Studio client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js)            |
| Purchase credits          | POST /api/gorm-studio/credits with priceId and returnTo; redirect to Stripe checkout                                            | [Studio client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js)            |
| Replace characters        | Multipart POST /api/gorm-studio/character-swap; status GET by jobId; restore and input routes                                   | [Character Swap client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/character-swap/page-2175ba0f42c1e8d8.js) |

These contracts were read from code delivered to anonymous browsers, rather than captured from paid requests. They are interface evidence, not proof of server-side authorization, transactional billing, provider cancellation or generation quality.

### Image-to-video interaction

The client supports up to four references from uploads or saved library file IDs. Image controls include automatic sizing, square/landscape/portrait formats, and low/medium/high quality. Generated images retain their prompts and can be reused as references. The user chooses a library image, opens an animation panel, describes motion, selects duration and starts a video. The original image remains a separate library asset. [Studio UI and client](https://studio.gormtheold.net/toolbox/gorm-studio).

### Job recovery and storage

Before submission, the client saves a UUID recovery identity in browser storage, scoped by account and operation kind. It distinguishes queued/running/done/error states, shows reserved/charged/returned credits, preserves unknown outcomes, and resumes status checks after reload. Main-studio polling has a bounded fifteen-minute observation window; each generation API request has a ninety-second transport timeout. If generation completes before library storage succeeds, it keeps the result and retries saving rather than ordering another generation. These are useful product and reliability patterns; durable backend guarantees require a separate server audit. [Job client](https://studio.gormtheold.net/_next/static/chunks/app/toolbox/gorm-studio/page-68ad425eba56accd.js).

### Character Swap specifics

The public form accepts an MP4 of 5-30 seconds, at most 50 MB, and asks that individual continuous shots remain within 15 seconds. It takes 1-4 PNG/JPEG/WebP photos, each at most 10 MB, optional instructions and a 768p/1080p choice. The interface calculates credits using rounded-up duration, requires rights/terms confirmation, and permits restoring scene/photos/settings from history. These are the application's limits, not necessarily the upstream model's full capability. [Character Swap](https://studio.gormtheold.net/toolbox/character-swap).

## Video and source boundaries

The landing page loads its explainer when the disclosure is expanded. The current [homepage](https://studio.gormtheold.net/) server payload configures Vimeo video **1246379440**, titled **Gorm Studio 2**, with a 4:3 aspect ratio; the rendered iframe confirms [that video](https://player.vimeo.com/video/1246379440). The [landing client](https://studio.gormtheold.net/_next/static/chunks/app/page-aad332238fb5ffd5.js) contains 1194766172 only as a component fallback, overridden by the server-supplied videoId. The fallback is not the current embedded demo. The title/content and transcript must be checked against 1246379440. A fresh fetch on the same date reconfirmed the studio model labels and tool-call contract described above.

No author-owned source repository was linked by the inspected pages, and a focused public GitHub search did not locate one. The Advanced route at /toolbox/country-videos redirects anonymous visitors to login. Consequently, the inspected evidence cannot establish the full feature set, backend source, private model configuration, authentication guarantees, account isolation, complete editing/composition tools or production quality. Avoid presenting those unknowns as features Gorm lacks.

## Most reusable ideas for Yap

The strongest observed additions are an image-first production step, an asset library retaining prompts and lineage, reuse of an existing still for animation, optional generated audio, and restoration/recovery without repeating paid work. These can be adapted to Yap's existing approval, quotes and provider adapters. Adding a provider or a similar user interface alone does not demonstrate better video quality; compare the same approved shots with live funded accounts before selecting a new default.
