# Poster style workspace

Open **Inspiration → Posters** at `#/references` in the React application. Browse a floating wall of portrait artwork, hover to inspect a poster, or open **Find a style** to search and filter. Choose one style to open the inline **What would you like to add to this design?** editor, describe the additions or changes, then choose **Save my direction**. The Videos/Posters tabs remain accessible while editing.

The backend combines that style's private instructions with the customer's changes and saves a prepared direction. Customers see the selected style, their own changes and the saved state. They do not receive reconstruction recipes or compiled prompts.

The preview remains the selected style reference. No poster image renderer or image generation provider is connected. Saving a direction does not generate a poster, make a paid provider request, or consume the existing production budget.

## Customer API

| Route                                                      | Behavior                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/posters/styles`                                  | Returns `{styles}` containing available reviewed poster styles.                                               |
| `GET /api/posters/references/:id/image?sha256=…`           | Returns only the catalogued crop, checked against its hash. Use the exact `imageUrl` supplied with the style. |
| `POST /api/posters/designs`                                | Accepts `{styleId, styleSha256, changes}` and returns HTTP 201 with `{design}`.                               |
| `GET /api/posters/designs/:id`                             | Returns the saved customer-facing `{design}`.                                                                 |
| `GET /api/posters/references`, `POST /api/posters/context` | Removed data endpoints; both return HTTP 404.                                                                 |

`PosterStyle` exposes only its ID, title, optional category, source attribution, image URL, crop dimensions and crop hash. `PosterDesign` contains an ID, the selected public style, the customer's changes, `status: "prepared"` and `createdAt`. Neither response contains visual analysis, reconstruction instructions, original style prompts or combined prompts. The shared contracts are exported from `@yap/contracts/posters` as `posterStylesResponseSchema`, `createPosterDesignSchema` and `posterDesignResponseSchema`.

A save requires one available style, its current `crop.sha256`, and nonempty changes of at most 4,000 characters. The hash binds the request to the image the customer selected. Invalid requests, unavailable styles and stale hashes fail explicitly; another style is never substituted. Saved designs retain their original style snapshot rather than being rebuilt from a later catalog revision.

## Private style packs and saved directions

Repository guidance keeps reference material and its derivatives under ignored `local-context/`. The API reads `local-context/poster-references/manifest.json` relative to the repository, independently of the server's working directory. A fresh clone without an installed pack returns an empty style library.

The empty collection has a **Try again** action. Installing or restoring a valid local pack, then retrying, loads its styles without resetting the workspace. An isolated preview in another worktree needs its own installed pack or an explicit `createApp({ posterReferencesDirectory: absolutePackDirectory })` pointing at an existing valid pack. Copying only the UI does not install the private reference images. Keep that pack and its recipes ignored; do not place them in the public asset directory.

The versioned manifest contains a `schemaVersion` of `1` and a `references` array validated by `posterManifestSchema` in `apps/api/src/poster-references.ts`. Each local entry records source attribution, reviewed crop metadata, observed design attributes and authored reconstruction instructions. These instructions describe a visual reconstruction; they are not recovered designer source code or original generation prompts. Source collections may be curated, so attribution does not establish individual authorship, ownership or permission to reuse an artwork.

The service accepts at most 64 catalog records and serves only reviewed, decodable PNG, JPEG or WebP crops. Missing or unreviewed crops remain unavailable. Invalid catalogs, unsafe paths, symlinks, mismatched hashes and inconsistent extraction dimensions are rejected. Source media, full frames and local helper files are not served by the poster routes. Reference resolution is preserved; a small crop is not a print master.

For each saved direction, the backend privately retains:

- The complete assembled original style prompt and its reference snapshot.
- The customer's changes as a separate field.
- The combined prompt, preserving the original style instructions and the customer's additions.
- The selected crop's SHA-256 identity and source attribution.

In the full application, `createApp` defaults this private store to `poster-designs.json` beside the configured project data file. `AppOptions.posterDesignDataFile` can override it. A directly mounted `createPosterRouter` accepts a `dataFile` option and otherwise defaults to `data/poster-designs.json` under its working directory. Keep custom storage paths ignored and outside publicly served directories.

The local repository serializes atomic writes and limits storage to 250 saved directions and 16 MiB. Malformed storage produces an error without overwriting accepted records. Saved directions remain available through their API IDs after a server restart. This follows the application's single-process local storage model; it is not a multi-user database.

## Reference room integration

The workspace retains three primary controls: **Your creations**, **Inspiration** and **Workspace guide**, plus the separate **New creation** action. Videos and Posters are local tabs within the same Inspiration route. This route presents the existing controls as a compact header; other workspace routes retain their normal shell.

`PosterWorkspace` is exported from `apps/web/src/posters/PosterWorkspace.tsx`. The room supplies a stable dirty-state callback and the active tab state:

```tsx
<PosterWorkspace onDirty={reportDirty} active={tab === 'posters'} />
```

Both inspiration panels remain mounted when switching tabs. Poster changes, the selected style and saved direction remain available on return; unsaved changes participate in the App's existing leave/discard guard. The native product gallery passes selected film IDs through its existing callback. Poster IDs and private instructions never enter the film handoff.

The `active` prop controls wall motion and interaction when the Posters tab is hidden or the style editor is open. Three balanced rows on desktop and two on mobile drift in alternating directions. Ambient movement is independent of keyboard selection: arrows, Home and End reveal and focus the chosen artwork immediately. Automatic movement pauses for hover, focus, dragging, a hidden document or an offscreen wall, and respects the reduced-motion preference and pause control. Changing tabs does not reset the poster workspace's draft state.

## Development privacy

The normal Vite configuration preserves its sensitive-file defaults and additionally denies filesystem access to `**/local-context/**` and `**/data/**`. This keeps private style instructions and saved prompt data outside the development asset surface while the explicit poster API serves safe style summaries and reviewed crops.

Keep private packs and runtime data outside public directories: Vite's filesystem deny list does not filter its public directory. Custom preview servers that bypass the normal Vite configuration need equivalent private-path restrictions before their asset middleware. [Vite filesystem restrictions](https://v7.vite.dev/config/server-options#server-fs-deny)

Focused checks:

```sh
npm run build --workspace=@yap/contracts
node --import tsx --test apps/api/test/poster-references.test.ts apps/api/test/poster-designs.test.ts
npm run typecheck
```
