# yap.

Good ideas, made REEL.

A cinematic frontend concept for an ideas-to-video product. The opening curved media wall gathers into a filmstrip as a phone reveals a sample deployed reel. The interface uses black, silver, and white; all color comes from the imagery.

## Run locally

Requires Node.js 20 or newer. No dependencies or install step are needed.

```sh
npm run dev
```

Open http://localhost:4173. Set `PORT` to change the port.

```sh
npm run check
npm run build
```

The static production site is written to `dist/`. It can be served by any static host.

## Experience

- Scroll to transform the same image elements from a three-row curved wall into the bottom filmstrip.
- Select a frame, drag horizontally, or use the previous/next buttons and arrow keys to change the phone preview.
- Open the studio to put an idea into the illustrative phone preview and choose a mood.
- Watch the included portrait clip in the phone or the full player. Playback, sample likes, and sample saves are interactive. The sample footage is silent.
- Explore the three product concept steps using the tabs or keyboard.
- Reduced motion shows the usable phone and filmstrip immediately. Ambient motion and video pause offscreen or in a hidden tab.
- An optional 2.8 second editorial opening cut can be tried from the footer or by opening `/?intro=1`. It is off by default, has a skip control, and is bypassed for reduced motion.

This is a hackathon frontend. Studio previews use sample imagery and footage; video generation, accounts, and social publishing are not connected.

## References and media

Composition and motion take inspiration from Motion's [Burst](https://motionin.design/gallery/burst), [Frieze](https://motionin.design/gallery/frieze), and [Crema](https://motionin.design/gallery/crema). The page is an original implementation rather than their source code.

Media provenance is recorded in `public/media/credits.json` and exposed on the site's Media credits page. Sample footage is from Mixkit under the Stock Video Free License. The `contact-sheet.jpg` is an asset review aid and is not loaded by the site.
