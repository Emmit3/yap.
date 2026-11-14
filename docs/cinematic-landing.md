# yap.

Good ideas, made REEL.

A cinematic frontend concept for an ideas-to-video product. Five rows of product films and photographs pan in alternating directions, then gather into a filmstrip as a phone reveals the selected study. The interface uses black, silver, and white; all color comes from the media.

## Run locally

The standalone showcase uses only Node.js built-ins. The complete workspace requires Node.js 22.12 or newer and the root dependency installation.

```sh
npm run dev:showcase
```

Open http://localhost:4173. Set `PORT` to change the port.

```sh
npm run check:showcase
npm run build:showcase
```

The static production site is written to `dist/`. It can be served by any static host.

## Experience

- Scroll to transform the same media elements from a five-row curved wall into the bottom filmstrip. Rows loop in alternating directions and freeze their pan position when the gathering transition starts.
- Each tile has its own source image or clip. The catalog covers food, cafés, flowers, homewares, fashion, beauty, technology, and other local businesses. A short catalog uses fewer balanced tiles instead of repeating media; the counter reflects the actual selectable examples.
- Product clips play muted and inline. The player scheduler limits active wall videos to eight on desktop and five on mobile (two with data saving enabled), pauses them offscreen or behind dialogs, and uses posters if autoplay is unavailable. The opening has a Pause motion control.
- The wall loads with a center-out camera arrival, unfolding image planes, and staggered headline reveals. Replay the wall from the footer. Scrolling interrupts the load cleanly.
- Select a frame, drag horizontally, or use the previous/next buttons and arrow keys to change the phone preview.
- Open the studio to put an idea into the illustrative phone preview and choose a mood.
- Watch the selected product film or inspect its photograph in the phone and full preview. A photo never substitutes another entry's video. Playback, sample likes, and sample saves are interactive. The sample footage is silent.
- Explore the three product concept steps using the tabs or keyboard.
- Reduced motion shows the usable phone and filmstrip immediately. Ambient motion and video pause offscreen or in a hidden tab.
- An optional 2.8 second editorial opening cut can be tried from the footer or by opening `/?intro=1`. It is off by default, has a skip control, and is bypassed for reduced motion.

The standalone showcase uses sample imagery and footage. When embedded in the React application, its studio and social navigation open the connected workspace. Accounts and automatic social posting are not connected.

## References and media

Composition and motion take inspiration from Motion's [Burst](https://motionin.design/gallery/burst), [Frieze](https://motionin.design/gallery/frieze), and [Crema](https://motionin.design/gallery/crema). The page is an original implementation rather than their source code.

Media provenance is recorded in `public/media/credits.json` and exposed on the site's Media credits page. `public/wall-media.json` selects the product loops and photographs, their labels, stable source identities, and credits. The showcase uses licensed stock media as illustrative product studies; these examples are not app-generated output. Each source credit records its exact page, license, and shipped file. The `contact-sheet.jpg` is an asset review aid and is not loaded by the site.
