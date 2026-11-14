# Yap product research

Research date: November 13, 2026. Retrieved with Firecrawl search and page scrape from official product websites. This is a focused workflow comparison, not a market validation study.

## Requirements and assumptions

The repository initially contained only the README tagline, **"good ideas, made REEL."** No original `project.md` was available. The user requested source implementation, research, multiple agents, and a clear frontend/backend separation so collaborators can work independently.

**Working product assumption:** Yap helps a creator turn an idea into an editable short video brief, script, and shot plan. This is an implementation direction inferred from the tagline, pending a more detailed product brief. Target audience, AI provider, pricing, publishing integrations, and video generation requirements have not been confirmed.

## What existing workflows show

| Official source                                                                 | Observed workflow                                                                                                       | Implication for Yap                                                                                                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [Descript script generator](https://www.descript.com/ai/script-generator)       | A prompt produces a first draft; the creator refines it, optionally starts from templates, and takes it into recording. | Make the draft editable and easy to copy or export. Generating text should lead to a usable recording plan.                                  |
| [Captions script to video](https://captions.ai/tools/script-to-video-generator) | Users can supply their own script or request one, choose an avatar, generate a video, and export it.                    | Accept existing creator input. Keep script planning distinct from avatar selection, media generation, and rendering.                         |
| [How OpusClip works](https://www.opus.pro/how-does-opus-clip-work)              | Existing long videos are analyzed, segmented, curated into shorter clips, edited, and prepared for sharing.             | Long video repurposing is a different input and processing pipeline. Do not imply an idea planner already supports clipping uploaded videos. |

These pages establish product behavior and positioning, not independent evidence of output quality, user demand, or engagement improvements. Their marketing performance claims were not used as requirements.

## Recommended first usable slice

1. Capture an idea with an audience, tone, platform, and target duration.
2. Produce a clearly labeled starter plan containing a hook, spoken script, scene timings, visual directions, and a closing action.
3. Let the creator edit and save the result, return to saved projects, and export a portable text plan.
4. Preserve project data across server restarts and return actionable validation errors.
5. Run the frontend and backend independently against one documented API contract.

This slice provides a complete planning loop without requiring video uploads, a rendering service, or social account credentials. If generation initially uses deterministic templates, identify it as a starter plan rather than claiming a live AI model generated it.

## Collaboration boundaries

- **Frontend:** project workspace, brief forms, script and scene editing, loading/error states, accessibility, and export UX.
- **Backend:** validation, project persistence, generation service boundary, API responses, and operational configuration.
- **Shared contract:** request/response types and validation constraints. Contract changes should include coordinated consumer changes.
- **Future integrations:** model providers, media storage, asynchronous rendering jobs, and publishing adapters should be replaceable services behind the API.

## Questions before expanding scope

- Is the primary job idea to script, idea to rendered video, or existing video to clips?
- Who is the first intended creator, and what stops them from making the next video today?
- Must several users edit the same project, or is independent developer collaboration the current requirement?
- Which output matters first: a recording plan, an MP4, or a post published to a social account?
- Which model/provider and operating cost are acceptable, if AI generation is required?

Multiuser collaboration, authentication, billing, asset uploads, rendering, and automatic social publishing remain scope decisions. Developer-friendly source separation does not by itself imply those product capabilities.
