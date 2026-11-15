# Create a frame, then animate it

The creator workspace includes a Visual studio shared by Guided and Director. It can generate and edit portrait images, keep earlier versions, compare an edited result with its actual source, and select a generated frame for a saved shot. Generated frames stay separate from uploaded creator photos and research references.

## Configure

Set `OPENAI_API_KEY` in `apps/api/.env` for direct OpenAI image generation and editing. The studio offers GPT Image 2.6 Flare and Sunburst, one opaque 864 by 1536 image per request, with low, medium or high quality. Existing OpenAI API credits apply to this direct API integration. Image creation does not depend on the drafting or Deep Agents model setting.

For image-first animation, set `CREATOR_VIDEO_PROVIDER=fal`, `CREATOR_VIDEO_MODEL=minimax-h3-max` and `FAL_KEY`. H3 Max uses a selected uploaded photo or generated frame for each shot. This bounded app profile supports 2–10 seconds per shot and requests 768P with prompt expansion disabled. The approved exports remain silent: native provider audio is removed from stored clips before review and assembly. No soundtrack or dialogue-production feature is implied.

The existing `seedance-v1.5-pro` setting supports text or photo starts. Omitting `CREATOR_VIDEO_MODEL` preserves that legacy fal default. Runway requires its explicit provider setting and `gen4.5` model. A model change requires preparing and approving a plan for that model; failures never switch providers automatically.

Restart the API after environment changes. Missing keys remain visible; saved versions can still be inspected, and sample generations are never substituted.

## Use the studio

1. Save an idea or your own media in a creation. Image creation is available before the script and shot plan are prepared.
2. Describe the frame or edit. Select a saved generated image or uploaded photo as the optional editing source.
3. Review the image cost estimate, then explicitly approve that image request. The quote fixes the prompt, model, quality and source identity.
4. Inspect the completed result. Edit it into another version, compare against its actual source, or return to earlier versions. Creating a candidate does not select it or alter the film's approval.
5. Prepare shots if needed, then choose **Use for this shot**. Selection saves a new plan revision and clears the previous video approval and quote.
6. Choose frames for the remaining H3 Max shots, review the saved prompts and exact current animation quote, then approve production. Animation and sampled visual review use the same selected frame bytes.

The Visual studio keeps per-creation and per-shot drafts, saved image versions, lineage and job receipts. Reloading reconciles accepted jobs before another request can be submitted. Unknown outcomes retain the original request identity; recovery does not silently buy another image. Cancellation is local and submitted provider work may still be billed.

## Cost and storage boundaries

Each image quote holds a conservative USD 2 estimate in the shared app budget before dispatch. This is an app reservation, not a guaranteed provider invoice ceiling. Valid reported token usage can settle the hold using the documented image-model rates, independently from the chat model's rates. Unknown outcomes retain it. A known rejection releases its unused hold. Known usage above the estimate is recorded and pauses further paid admission until spending is reconciled; the paid image result remains available.

The repository atomically consumes an image quote, creates the job and reserves its cost. It allows two local image workers and one active image request per creation, with at most 120 image jobs and versions per creation. Restart marks interrupted work failed rather than replaying a paid POST. Unsubmitted holds are released; submitted unknown outcomes stay reserved.

Generated files are decoded, bounded, stored by server-issued IDs and verified by size and SHA-256 when loaded. Selected frame IDs and hashes participate in the video quote fingerprint. Cross-creation references and changed source hashes are rejected. The application remains a single-process local workspace; account isolation and distributed job recovery are not implemented.

## API routes

All paths below are under `/api/creator`:

| Route                                      | Behavior                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `GET /sessions/:id/images`                 | Configuration state, saved generated versions and image jobs.                             |
| `POST /sessions/:id/images/quote`          | Version-checked quote for exact image settings and source.                                |
| `POST /sessions/:id/images/jobs`           | Explicit cost approval and durable request ID; returns an existing matching job on retry. |
| `GET /sessions/:id/images/jobs/:jobId`     | Persistent status and result identity.                                                    |
| `DELETE /sessions/:id/images/jobs/:jobId`  | Local cancellation without another paid request.                                          |
| `GET /sessions/:id/images/:variantId/file` | Integrity-checked owned generated raster.                                                 |
| `POST /sessions/:id/keyframe`              | Explicit current-plan frame selection; invalidates video approval.                        |

Image settings and records are defined in `@yap/contracts/creator-images`. Quote/start/select mutations require current creator and workflow versions. A generated keyframe is an editable creative asset, not evidence that depicted product facts are true.

## Validation limits

Tests use injected provider responses and generated raster/video fixtures to exercise the complete image-to-animation-to-audit-to-export path. They establish request construction, ownership, lineage, billing admission, integrity and version behavior. They do not establish live model access, output quality or reconciled provider invoices. The current visual reviewer still examines three sampled frames; it cannot certify continuous motion or the entire film's creative quality.
