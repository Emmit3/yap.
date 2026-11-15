# Brand controls and local film editing

Workspace brand settings and free local edits are separate from generated clip receipts, production attempts and spending. Applying a brand to a creator plan is explicit: the current immutable snapshot becomes part of its quote and approval. Saving workspace settings does not silently change an existing film.

## Workspace brand service

`createBrandService(directory)` opens `creator-brand.json` with one serialized atomic writer. Missing files start with an empty brand; malformed or oversized storage fails instead of being reset. Settings have optimistic `version` checks and offer a brand name, sans/serif/monospace font choice, three colours, logo and optional end card. End cards occupy the final approved seconds; they never extend a paid production's duration.

- `get()` returns `BrandSettings`.
- `update({expectedVersion, brand})` saves validated settings and increments the version.
- `uploadLogo({expectedVersion, bytes})` accepts at most 8 MiB of actual PNG/JPEG/WebP input, rejects animation and SVG, bounds decoding to 20 megapixels, normalizes orientation and saves a PNG no larger than 1024×1024. Its receipt records dimensions, bytes and SHA-256. The library retains at most 64 unique logos so approved snapshots retain their original assets.
- `clearLogo({expectedVersion})` changes future settings while retaining approved logo bytes.
- `snapshot()` returns settings plus a canonical settings hash. `verifySnapshot(snapshot)` checks that hash and saved logo integrity. `logoPath(receipt)` returns a server-owned path, never a client-supplied filename.
- `renderBrandMovie({input, output, directory, brand, logoPath?, signal, metadata})` applies the explicit snapshot to a verified source and preserves duration, dimensions and audio. It returns a fully decoded size/hash receipt. `subtitleStyle(snapshot)` supplies the chosen font and ASS colours for subtitle integration.

Font selection uses an explicit system font file copied into the private render directory: Arial/Georgia/Consolas on Windows, Arial/Georgia/Menlo on macOS, and DejaVu Sans/Serif/Sans Mono on Linux. Missing fonts return an actionable error instead of silently substituting a different brand typeface. The renderer applies branding before new subtitle burn-in so an end card does not cover the final subtitle cues. Edits of an already burned-in film retain those pixels; a newly added end card intentionally replaces the original picture in its selected final interval.

Clients use `GET /api/creator/brand` and `PATCH` with `{expectedVersion,brand}`. Responses contain `{brand,snapshot}`. Logo upload is a raw `PUT /api/creator/brand/logo?expectedVersion=N`; removal uses `DELETE /api/creator/brand/logo` with `{expectedVersion}`. `GET /api/creator/brand/logo/:sha256.png` serves only a verified current logo. `BrandControls` takes `{sessionId,onApply(snapshot|null)}` so the parent explicitly saves that snapshot into the film plan and invalidates its previous approval.

## Versioned edit service

Saved trim and dissolve times snap to the editor's 24 fps frame grid; the returned revision shows the actual saved times. This prevents encoder rounding from accumulating across separately encoded slices.

`createEditService(directory)` owns `creator-edits.json`, temporary work and `edit-renders/`. The caller supplies an already authorized finished generation job and a verified `EditBaseFilm` receipt with ordered source-clip windows. The service does not fetch URLs, change generation jobs or renew paid retry limits.

- `list(sessionId)`, `get(sessionId,editId)` and `history(sessionId,editId)` return session-scoped records.
- `create(sessionId,base)` creates version one with all approved clips in order.
- `update(sessionId,editId,{expectedVersion,draft})` creates a new saved version. Drafts contain ordered `sourceClipId` slices, trim offsets, cut/dissolve transitions, timed text layers and an optional verified brand snapshot. Trims stay inside the source clip. Dissolves must fit both neighbours. Text must stay inside the resulting film. Up to 60 saved versions are retained; restoring one means saving it as a new version.
- `render(sessionId,editId,{expectedVersion,reviewed:true},verifiedSourcePath,signal)` requires explicit review. It rechecks the base hash, renders selected slices with their existing audio and burned subtitles, joins video and sound with matching dissolves, applies text and any chosen brand, fully decodes the final film and stores an immutable receipt. A manual cut can shorten a spoken word or a burned caption. It does not claim automatic speech-aware editing.
- `verifyOutput(sessionId,editId,renderId)` returns `{path,receipt}` only for a verified render of the current edit version. Missing, replaced and stale outputs fail. The caller also checks that the base generation job remains accessible before serving preview/download.

Routes used by `TimelineEditor({sessionId,jobId})`:

| Route under `/api/creator`                                | Body / result                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /sessions/:id/edits`                                 | `{edits}`                                                                |
| `POST /sessions/:id/edits`                                | `{jobId}` → `{edit}`; server constructs the base from the authorized job |
| `GET /sessions/:id/edits/:editId`                         | `{edit}`                                                                 |
| `PATCH /sessions/:id/edits/:editId`                       | `{expectedVersion,draft}` → `{edit}`                                     |
| `GET /sessions/:id/edits/:editId/history`                 | `{history}`                                                              |
| `POST /sessions/:id/edits/:editId/render`                 | `{expectedVersion,reviewed:true}` → `{render}`                           |
| `GET /sessions/:id/edits/:editId/renders/:renderId/video` | Verified inline MP4; `?download=1` requests a download                   |

The local renderer permits one active edit, at most 24 slices and 24 text layers, a maximum two-minute output and at most 40 renders per edit. Each FFmpeg process is bounded to three minutes and the whole edit to five minutes. Storage is bounded to 8 MiB and 200 edit documents. Server-generated filenames, literal text files and fixed filter expressions keep creator copy out of shell commands and filter programs.

The focused tests exercise persistence conflicts and corruption, normalized logo receipts and tampering, session isolation, trim bounds, explicit review, real trimmed/reordered audio-video dissolves, literal text, preview integrity and branding without changing duration or sound. These local checks do not establish live provider quality, distributed jobs or account isolation.
