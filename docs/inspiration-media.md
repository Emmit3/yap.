# Inspiration media verification

[public/inspiration-media.json](../public/inspiration-media.json) augments the existing film catalog without changing its editorial records. Checked November 14, 2026: **88 source-bound media mappings with verified thumbnail URLs**. Together with the catalog's explicit verified preview URLs and video evidence, the native gallery resolves **90 supported previews** across the 103 entries: 60 Vimeo, 8 YouTube, 19 Mux and 3 direct videos. The two Panoply WebM clips have no verified still thumbnail. Unsupported source cases remain in the catalog and existing saved lists, without becoming fabricated preview tiles.

Verification means reading the creator case or its existing explicit video evidence, checking public provider metadata, and checking HTTP availability/content types. Vimeo/YouTube oEmbed returned actual thumbnail URLs; newly added thumbnail responses were fetched, decoded and checked at a minimum width of 320 pixels. Mux player pages and the two Adidas HLS manifests returned 200; posters returned image responses. Rimmel's exact public MP4 returned 200 with video/mp4. Orca browsing confirms visible muted previews for the initial selection; it does not establish full decoding or availability of all 90 clips in every browser or region. Media remains on its original hosts.

## Priority sources

| Film                   | Verified mapping                                                                                          | Primary source                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Adidas Ultra Boost 21  | Named hero Mux player j1ppGEgL3KUlOWbx02UzLWDt7zL4M2QiI4KAJ4o700Y100 and its matching source poster       | [Builders Club case](https://builders-club.com/projects/adidas-ultra-boost-21)    |
| Adidas Originals ZX    | Named main Mux player 7amg8WBWPZ1VaEzsFVqG7pYDWmgjKzEziwRJfFhAzCA; separate VFX breakdown excluded        | [Builders Club case](https://builders-club.com/3d-motion/adidas-originals-zx)     |
| Powerbeats Pro 2       | Vimeo 1055994596, confirmed in the creator case and public oEmbed                                         | [FutureDeluxe case](https://futuredeluxe.com/work/beats)                          |
| On Running / The Cloud | Vimeo 691324833 and its returned thumbnail                                                                | [FutureDeluxe case](https://futuredeluxe.com/work/on-running)                     |
| G/FORE G/18            | Vimeo 985846400 and its returned thumbnail                                                                | [FutureDeluxe case](https://futuredeluxe.com/work/g-fore)                         |
| Arc'teryx SS24         | Vimeo 961042980 and its returned thumbnail                                                                | [FutureDeluxe case](https://futuredeluxe.com/work/arcteryx)                       |
| Bird & Blend           | Vimeo 1238004406 with required source hash 2573484b0e retained                                            | [Move Animation case](https://www.moveanimation.com/bird-and-blend/)              |
| Magnum Remix           | Vimeo 713718052 and its returned thumbnail                                                                | [ManvsMachine case](https://mvsm.com/project/magnum)                              |
| Lancôme Idôle          | YouTube fMMXpBKzMuc and its returned thumbnail                                                            | [Already Been Chewed case](https://www.alreadybeenchewed.tv/lancome)              |
| Ecobee SmartHome       | Product clip 395076720, titled Ecobee Thermostat; replaces the catalog's five-second Web Header 398227544 | [FutureDeluxe case](https://futuredeluxe.com/work/ecobee)                         |
| Rimmel Supergel        | Exact 1080p.mp4 from the creator case; matching Mux thumbnail endpoint returned image/webp                | [Frantic case](https://www.wearefrantic.com/portfolio/rimmel-supergel-animation/) |

The remaining mappings retain their exact catalog source URL in each record. oEmbed lookups used Vimeo's public `https://vimeo.com/api/oembed.json?url=...` and YouTube's public `https://www.youtube.com/oembed?url=...&format=json`; returned player identities and thumbnail hosts were inspected. No API keys or private media URLs were used.

## Playback and fallback boundaries

Mux's official [hosted iframe guide](https://www.mux.com/docs/guides/player-mux-com) and [parameter reference](https://www.mux.com/docs/guides/player-mux-com-reference) document `https://player.mux.com/{PLAYBACK_ID}`. The Adidas MP4 alternatives high.mp4, 1080p.mp4, and 720p.mp4 returned 404, so the registry uses the documented hosted HLS player instead. [Mux static rendition documentation](https://www.mux.com/docs/api-reference/stream/streaming/get-static-rendition) explains that MP4 support must be enabled; an HLS playback ID alone does not establish MP4 availability. Existing cached case HTML reported media network errors; the later manifest check establishes availability, not successful browser playback.

The registry's `unavailable` entries deliberately suppress every automatic preview fallback for:

- **Onesal Tasty Cleaning:** cataloged Vimeo 921929631 resolves to a general Exploration Reel; no dedicated product clip was established.
- **Milia Matcha:** the official case exposes Floraison/Cérémonie MP4 and WebM sources, but the checked MP4 and poster returned 403. Keep the [creator case](https://tybannmasson.fr/en/work/milia-matcha/) available as the external destination.

Embeds, direct media, and thumbnails remain on original providers. The dark gallery presents media tiles without persistent card copy or action buttons. Hover or keyboard focus reveals a title and short description; clicking opens an inline detail view with full playback, attribution, saved-list controls and reference handoff.

At most six sufficiently visible tiles acquire muted looping previews. Offscreen tiles, a hidden page, an inactive tab, an open detail view, the pause control or reduced motion remove preview players. Preview URLs use provider-specific chromeless parameters; full playback retains the original validated player URL and controls. Search, categories, saved films and a preview-pause control appear in the search menu. The workspace menu opens the existing navigation; it does not add a primary destination.

These references provide creative context; they are not creator-owned production assets or evidence of reuse permission. Playback remains subject to the original provider's availability, permissions and browser autoplay rules.
