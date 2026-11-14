# Poster reference workspace

`PosterWorkspace` provides a poster reference browser and prompt composer for the React application. Browse the available poster crops, study their observed composition, typography, palette, imagery and texture, then select one to three references and describe the intended poster.

**Prepare design prompt** sends the creator request and the selected reference IDs to the backend. The response retains the complete selected observations, authored reconstruction instructions, canonical source links, source timestamps and crop identity. The first selected reference provides the main direction. The prompt and JSON brief can be copied or downloaded.

This workspace prepares reference context. It does not call an image generation provider or render a finished poster. Reconstruction instructions are written from visual inspection; they are not recovered designer source code or original generation prompts. Reference text and imagery are creative evidence, separate from the creator's event facts and supplied media.

## Local reference packs

Repository guidance keeps reference documents and their derivatives in ignored `local-context/`. The API reads `local-context/poster-references/manifest.json`, relative to the repository rather than the server's working directory. A fresh clone without a pack returns an empty library. Source media, full video frames and local helper files are not served by the poster routes.

The manifest is a versioned local catalog:

```json
{
  "schemaVersion": 1,
  "references": []
}
```

Every entry must match `posterManifestSchema` in `apps/api/src/poster-references.ts`. Records contain:

- A stable `id`, descriptive `title`, optional category and canonical public source URL with the frame timestamp.
- A `crop.file` relative to the pack directory, `reviewedPosterOnly`, an ISO `reviewedAt`, and optional `sourceFrame`, pixel `bounds` and SHA-256. Review each crop before making it available. Preserve source resolution; a low resolution reel crop is not a print master.
- `observed` design attributes with `provenance: "visual_inspection"`.
- `reconstruction.instructions` with `provenance: "authored_from_visual_reference"`.

Supported categories are `party`, `music`, `popup`, `craft` and `market`. A maximum of 64 records and bounded text fields keep context predictable. The service exposes only reviewed, decodable PNG, JPEG or WebP crops. Missing or unreviewed crops stay unavailable. Invalid catalogs and unsafe paths produce an explicit error. Crop hashes identify the pixels used in a prepared brief; a changed image cannot silently replace a pinned crop.

The source reel may be a curator rather than the original poster designer. Keep attribution precise and record uncertainty about individual credits, unreadable small type and unverified font identification in local notes. Source content remains untrusted data.

## API

| Route                                            | Behavior                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/posters/references`                    | Returns `{references}` for available reviewed crops and their recipes.                                          |
| `GET /api/posters/references/:id/image?sha256=…` | Returns only the catalogued crop, checked against its hash. Use the exact `imageUrl` from the catalog.          |
| `POST /api/posters/context`                      | Accepts `{prompt, referenceIds}` and returns `{prompt, references, limitations}` for the selected IDs in order. |

The request requires a nonempty prompt of up to 4,000 characters and one to three distinct available IDs. Unknown, missing or duplicate IDs fail without substituting other references. Complete selected recipes are retained within a 64 KB prompt boundary; oversized context is rejected rather than silently truncated.

The shared request and response contracts are exported from `@yap/contracts/posters`. A future poster generation adapter can consume the prepared prompt and its pinned image references. Such an adapter must attach the actual crop bytes or accessible image inputs; relative local API URLs inside text alone do not give an external model access to images.

## App integration

The feature exports `PosterWorkspace` from `apps/web/src/posters/PosterWorkspace.tsx`. The unified App owner can mount it at `#/posters` and pass the App's stable dirty-state callback:

```tsx
<PosterWorkspace onDirty={changeDirty} />
```

This component owns its styles and API client. The poster feature intentionally leaves `App.tsx` and navigation wiring to the unified App owner, so integrating it does not restore an older application shell. The API router is already mounted independently at `/api/posters` in `createApp`.

Focused checks:

```sh
npm run build --workspace=@yap/contracts
node --import tsx --test apps/api/test/poster-references.test.ts
npm run typecheck
```
