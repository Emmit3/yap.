import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
await mkdir(directory, { recursive: true });

// Optional local font file for reproducing the exported bitmap typography.
// The SVG remains editable text and uses Manrope with a sans-serif fallback.
if (process.env.YAP_DOCS_FONT_FILE) {
  await sharp({
    text: { text: 'yap.', font: 'Manrope 12', fontfile: process.env.YAP_DOCS_FONT_FILE },
  })
    .png()
    .toBuffer();
}

const C = {
  paper: '#f7f7f5',
  white: '#ffffff',
  ink: '#232421',
  muted: '#62695b',
  line: '#dadfd5',
  accent: '#c9402b',
  soft: '#fff0e9',
  tray: '#eff1eb',
};
const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const text = (x, y, size, value, fill = C.ink, weight = 400, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${escape(value)}</text>`;
const rect = (x, y, w, h, fill = C.white, stroke = C.line, r = 16) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="1.5"` : ''}/>`;
const line = (path, color = C.muted, arrow = true, dashed = false) =>
  `<path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"${arrow ? ` marker-end="url(#${color === C.accent ? 'arrow-coral' : 'arrow'})"` : ''}${dashed ? ' stroke-dasharray="7 8"' : ''}/>`;
const marker = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="${C.muted}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker><marker id="arrow-coral" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="${C.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`;
const svg = (w, h, title, description, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc"><title id="title">${escape(title)}</title><desc id="desc">${escape(description)}</desc><g font-family="Manrope, DejaVu Sans, sans-serif">${body}</g></svg>`;

let diagram = marker + rect(0, 0, 1800, 1500, C.paper, null, 0);
diagram += text(80, 98, 62, 'yap', C.ink, 700) + text(193, 98, 62, '.', C.accent, 700);
diagram += text(275, 96, 48, 'From evidence to a reviewed reel.', C.ink, 600);
diagram += text(
  80,
  151,
  24,
  'Public research informs the framing. Creator facts and approval stay with the creator.',
  C.muted,
);

// Connectors sit behind the labeled stages.
diagram += line('M 360 286 H 403');
diagram += line('M 620 344 V 375 H 240 V 412');
diagram += line('M 400 474 H 434');
diagram += line('M 760 474 H 794');
for (const x of [240, 600, 960]) diagram += line(`M ${x} 530 V 568`);
diagram += line('M 1120 660 H 1234');
diagram += line('M 1480 744 V 808');
diagram += line('M 310 944 V 988', C.muted, false);
diagram += line('M 1480 944 V 988 H 310', C.accent, false);
diagram += `<circle cx="310" cy="988" r="5" fill="${C.accent}"/>`;
diagram += line('M 310 988 V 1034');
diagram += line('M 540 1112 H 614');
diagram += line('M 1080 1112 H 1154');
diagram += line('M 1440 1185 V 1235 H 850 V 1274', C.accent);
diagram += line('M 1080 1343 H 1154');

diagram += rect(80, 228, 280, 116);
diagram += text(110, 274, 29, 'Public sources', C.ink, 600);
diagram += text(110, 311, 22, 'Firecrawl · X · Grok', C.muted);
diagram += rect(410, 228, 420, 116, C.ink, null);
diagram += text(440, 274, 30, 'Deep Agents coordinator', C.white, 600);
diagram += text(440, 311, 22, 'Plans · bounds work · delegates', '#e0e4dc');
diagram += text(960, 286, 22, 'One cached collection batch', C.muted, 500);
diagram += text(960, 320, 20, 'Live harness is optional; replay is labeled.', C.muted);
diagram += text(800, 393, 20, 'Sequential specialist handoffs', C.muted, 500);

for (const [x, title, body] of [
  [80, 'Source researcher', 'Public evidence + provenance'],
  [440, 'Network analyst', 'Content + observed connections'],
  [800, 'Creative strategist', 'Strengths + tradeoffs'],
]) {
  diagram += rect(x, 418, 320, 112);
  diagram += text(x + 26, 462, 27, title, C.ink, 600);
  diagram += text(x + 26, 500, 20, body, C.muted);
}
diagram += rect(80, 574, 1040, 170, C.tray);
diagram += text(110, 615, 26, 'Shared research filesystem', C.ink, 600);
diagram += text(897, 615, 20, 'StateBackend', C.muted, 600);
for (const [index, name] of [
  'scope.json',
  'sources.json',
  'network.json',
  'insights.json',
  'brief.md',
].entries()) {
  const x = 110 + 196 * index;
  diagram += rect(x, 635, 180, 44, C.white, C.line, 8);
  diagram += text(x + 90, 664, 20, name, C.ink, 500, 'text-anchor="middle"');
}
diagram += text(110, 710, 21, '/research/', C.accent, 600);
diagram += text(
  260,
  710,
  20,
  'Run-local virtual files; five allowlisted previews and curated activity.',
  C.muted,
);

diagram += rect(1240, 418, 480, 326);
diagram += text(1270, 463, 30, 'Evidence graph', C.ink, 600);
diagram += text(1270, 501, 22, 'Content alongside public connections', C.muted);
for (const p of ['M 1320 575 L 1430 545', 'M 1430 545 L 1535 595', 'M 1535 595 L 1650 555'])
  diagram += line(p, C.ink, false);
for (const p of ['M 1430 545 L 1455 660', 'M 1455 660 L 1640 670'])
  diagram += line(p, C.accent, false, true);
for (const [x, y, fill, stroke] of [
  [1320, 575, C.ink, C.ink],
  [1430, 545, C.white, C.accent],
  [1535, 595, C.white, C.accent],
  [1650, 555, C.ink, C.ink],
  [1455, 660, C.white, C.accent],
])
  diagram += `<circle cx="${x}" cy="${y}" r="15" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`;
diagram +=
  rect(1608, 654, 66, 32, C.soft, C.accent, 8) +
  text(1641, 676, 15, 'topic', C.accent, 600, 'text-anchor="middle"');
diagram += line('M 1270 710 H 1310', C.ink, false) + text(1322, 717, 18, 'Observed', C.ink, 500);
diagram +=
  line('M 1475 710 H 1515', C.accent, false, true) + text(1527, 717, 18, 'Derived', C.accent, 500);

diagram += rect(80, 814, 1040, 130);
diagram += text(110, 858, 30, 'Creator’s own facts + photos', C.ink, 600);
diagram += text(
  110,
  899,
  24,
  'Product details, audience, goal, and actual supplied images',
  C.muted,
);
diagram += rect(1240, 814, 480, 130, C.soft, C.accent);
diagram += text(1270, 857, 27, 'Reviewed research direction', C.ink, 600);
diagram += text(1270, 895, 22, 'Select notes to adopt, avoid, or test.', C.muted);
diagram += text(1270, 925, 20, 'Source attribution follows the selection.', C.muted);
diagram += text(995, 978, 20, 'Creative context only', C.accent, 500);

diagram += rect(80, 1040, 460, 145);
diagram += text(110, 1085, 29, 'Script + scene proposal', C.ink, 600);
diagram += text(110, 1127, 23, 'Guided or configured OpenAI', C.muted);
diagram += text(110, 1161, 23, 'Original wording; photo references', C.muted);
diagram += rect(620, 1040, 460, 145);
diagram += text(650, 1085, 29, 'Structural verification', C.ink, 600);
diagram += text(650, 1127, 23, 'Timing · durations · asset IDs', C.muted);
diagram += text(650, 1161, 23, 'Provenance · revisions · coverage', C.muted);
diagram += rect(1160, 1040, 560, 145, C.soft, C.accent);
diagram += text(1190, 1085, 29, 'Explicit creator approval', C.ink, 600);
diagram += text(1190, 1127, 24, 'Accept this exact content version', C.ink, 500);
diagram += text(1190, 1161, 23, 'Structural checks do not approve for you.', C.muted);
diagram += text(1010, 1224, 20, 'Only current, approved material', C.accent, 500);

diagram += rect(80, 1280, 460, 126, C.ink, null);
diagram += text(110, 1325, 28, 'Content changed?', C.white, 600);
diagram += text(110, 1364, 21, 'Reset downstream artifacts + approvals.', '#e0e4dc');
diagram += rect(620, 1280, 460, 126);
diagram += text(650, 1325, 30, 'Sharp + FFmpeg', C.ink, 600);
diagram += text(650, 1364, 23, 'Supplied photos + pinned scenes', C.muted);
diagram += rect(1160, 1280, 560, 126);
diagram += text(1190, 1325, 30, 'Vertical MP4 + caption', C.ink, 600);
diagram += text(1190, 1364, 23, '1080 × 1920 · silent · manual posting', C.muted);
diagram += text(
  80,
  1463,
  21,
  'Structural checks validate consistency. Creator review determines which claims and visuals to use.',
  C.muted,
);

const architecture = svg(
  1800,
  1500,
  'Yap architecture: evidence, verification, creator approval, and rendering',
  'Public sources enter a Deep Agents coordinator that delegates specialists in dependency order: source researcher, then network analyst, then creative strategist. Five run-local virtual files feed a graph with observed links and derived similarities. The creator reviews selected research as attributed framing, separately supplies their own facts and photos, and reviews a script and scene proposal. Structural checks validate timing, durations, provenance, source versions, scene coverage, and photo references; they do not certify factual truth. Only explicit creator approval of the current content version authorizes Sharp and FFmpeg rendering into a silent vertical MP4 and caption for manual posting. Content edits invalidate downstream artifacts and approvals.',
  diagram,
);
await writeFile(resolve(directory, 'architecture.svg'), architecture);
await sharp(Buffer.from(architecture))
  .png({ compressionLevel: 9 })
  .toFile(resolve(directory, 'architecture.png'));

const W = 1800,
  H = 1120;
let overlay = rect(0, 0, W, H, '#121312', null, 0);
overlay += text(80, 128, 90, 'yap', '#f7f7f5', 700) + text(245, 128, 90, '.', C.accent, 700);
overlay += text(370, 121, 63, 'Good ideas, made REEL.', '#f7f7f5', 600);
overlay += text(374, 169, 25, 'Evidence-led framing. Creator-led decisions.', '#c4c9bf');
const panels = [
  {
    file: 'product-camera.jpg',
    label: 'Camera study',
    x: 80,
    y: 230,
    w: 440,
    h: 530,
    position: 'centre',
  },
  {
    file: 'wall-synthesizer-hands.jpg',
    label: 'Keyboard performance',
    x: 544,
    y: 230,
    w: 560,
    h: 252,
    position: 'centre',
  },
  {
    file: 'wall-audio.jpg',
    label: 'Audio study',
    x: 544,
    y: 508,
    w: 560,
    h: 252,
    position: 'centre',
  },
  {
    file: 'product-vinyl-records.jpg',
    label: 'Record store',
    x: 1128,
    y: 230,
    w: 592,
    h: 530,
    position: 'north',
  },
];
const composites = [];
for (const panel of panels) {
  const photograph = await sharp(await readFile(resolve(repository, 'public/media', panel.file)))
    .resize(panel.w, panel.h, { fit: 'cover', position: panel.position })
    .toBuffer();
  composites.push({ input: photograph, left: panel.x, top: panel.y });
}
let captions = '';
for (const panel of panels) {
  captions += rect(panel.x, panel.y + panel.h - 49, panel.w, 49, '#121312', null, 0);
  captions += text(panel.x + 20, panel.y + panel.h - 17, 22, panel.label, '#f7f7f5', 500);
}
captions += text(80, 842, 43, 'Research. Review. Create.', '#f7f7f5', 600);
captions += text(1333, 839, 25, 'Creator stays in control.', '#c4c9bf', 500);
const steps = [
  'Public evidence',
  'Selected direction',
  'Own facts + photos',
  'Review + approve',
  'Render',
  'MP4 + caption',
];
for (const [index, step] of steps.entries()) {
  const x = 80 + index * 275;
  captions += text(x, 920, 23, step, '#f0f2ec', 500);
  if (index < steps.length - 1)
    captions += `<path d="M ${x + 231} 911 H ${x + 256} M ${x + 249} 904 L ${x + 256} 911 L ${x + 249} 918" fill="none" stroke="${C.accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
}
captions += `<path d="M 80 968 H 1720" stroke="#3b4038" stroke-width="1"/>`;
captions += text(80, 1017, 24, 'Website media + workflow overview', '#f0f2ec', 600);
captions += text(
  80,
  1052,
  21,
  'Existing stock studies; not app-generated video or an interface screenshot.',
  '#b7bfb0',
);
captions += text(
  80,
  1087,
  18,
  'Photography: dlxmedia.hu and Sou Jest / Unsplash. Video stills: Mixkit. Full source credits: docs/assets/README.md.',
  '#a5ae9d',
);
const background = Buffer.from(
  svg(
    W,
    H,
    'Yap website media and workflow overview',
    'A documentation composition of four real assets already shipped on the Yap website: a camera, keyboard performance, headphone study, and record store. The overview follows public evidence through selected creative direction, creator facts and photos, review and approval, rendering, and an MP4 with caption. Stock media is illustrative and is not app-generated output or a screenshot.',
    overlay,
  ),
);
const foreground = Buffer.from(svg(W, H, '', '', captions));
await sharp(background)
  .composite([...composites, { input: foreground, left: 0, top: 0 }])
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
  .toFile(resolve(directory, 'website-media-overview.jpg'));
console.log(
  'Generated architecture.svg, architecture.png, and website-media-overview.jpg from repository assets.',
);
