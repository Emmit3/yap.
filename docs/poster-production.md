# Poster production foundation

## Implemented

The style workspace still saves a **prepared direction**; it does not generate or render an image. Saving performs no paid request. The backend now compiles and privately persists a production plan alongside the selected reference snapshot and existing prompts.

`compilePosterPlan` in [`apps/api/src/poster-production.ts`](../apps/api/src/poster-production.ts) resolves the style's optional composition with an optional structured brief. It retains exact copy, records missing or incompatible inputs, and fingerprints the reference image hash, authored instructions, changes, brief, and composition together. It never interprets freeform requests or reference lettering as approved copy.

`materializePosterArtwork` validates that plan against its saved reference snapshot and loads the actual hash-checked reference bytes using `PosterReferenceLibrary.readImage`. It returns separate artwork requests, binary reference input, and exact text layers. It does not call an image provider, resolve fonts, render layers, or export a finished poster.

## Composition and copy

Private catalog entries may include a `composition` validated by `posterCompositionSchema`:

- Canvas width and height, each from 320 to 4096 pixels, and a bounded hex palette.
- One to eight artwork layers with unique IDs, normalized regions, stacking positions, treatments and transparency requirements.
- One to three unique text roles: `headline`, `subheading`, and `details`. A headline slot is mandatory.
- Each text slot has a normalized region, display/body font role, relative font scale, color, alignment, stacking position, character limit and explicit artwork-overlap policy.

Regions must fit completely inside the canvas. The overlap policy allows intentional headline/subject interplay while identifying regions that artwork must leave clear. Character limits screen out clearly incompatible copy; they do not prove that the selected font fits. Font measurement and final legibility checks remain unimplemented.

The optional customer request field is:

```json
{
  "brief": {
    "copy": {
      "headline": "NIGHT SHIFT",
      "details": "NOV 28\nDOCK HALL"
    },
    "canvas": { "width": 1080, "height": 1350 }
  }
}
```

It accompanies the existing `styleId`, `styleSha256` and `changes` fields in `POST /api/posters/designs`. Saved responses include the brief, including exact whitespace and line breaks. The current browser form continues to supply freeform changes; it does not yet collect these structured fields.

Plans record `missing-composition`, `missing-headline`, `copy-exceeds-slot`, or `unsupported-copy-role` rather than substituting text, inventing layout, or dropping a supplied role. Any issue blocks artwork-input preparation. Older styles without compositions can still be browsed and saved as directions.

## Storage and privacy

Public style/design responses exclude composition templates, production plans, observations, recipes and prompts. The customer receives their own brief, selected style and saved state. Reference attribution supports static public posts without an artificial video timestamp; existing reel timestamps remain supported.

The private store retains the compiled plan and its complete reference snapshot. New reads verify their consistency. Historical records without a plan continue to open without a write or a plan reconstructed from a newer catalog. A changed plan fails storage validation; accepted records are not overwritten to repair it.

## Production is a separate next stage

A connected image adapter, durable generation jobs, exact-cost approval, a layer compositor, selected-result corrections and verified image exports remain proposed. No generation, quote, approval, job or export endpoint is introduced here. Reuse the creator application's existing budget rules when implementing those operations; its current reservation categories do not yet include posters.

The workspace architecture and implementation sequence are recorded in the ignored local planning material. Public documentation will change as individual production capabilities become implemented and verified.

## Verification

```sh
npm run build --workspace=@yap/contracts
node --import tsx --test apps/api/test/poster-production.test.ts apps/api/test/poster-designs.test.ts apps/api/test/poster-references.test.ts
npm run typecheck
```
