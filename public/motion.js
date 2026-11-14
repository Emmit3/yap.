export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const lerp = (from, to, progress) => from + (to - from) * progress;
export const smooth = (value) => { const t = clamp(value); return t * t * (3 - 2 * t); };
export const phase = (progress, from, to) => smooth((progress - from) / (to - from));

export function wallLayout(width, height) {
  const mobile = width < 700;
  const rows = 5;
  const gap = mobile ? 12 : 14;
  const cardWidth = Math.min(300, width * (mobile ? .52 : .255), height * .175 / .64);
  const cardHeight = cardWidth * .64;
  const spacing = cardWidth + gap;
  const estimate = Math.ceil(width / spacing) + (mobile ? 4 : 6);
  const columns = estimate % 2 ? estimate : estimate + 1;
  return { mobile, rows, columns, count: rows * columns, cardWidth, cardHeight, gap, spacing,
    radius: Math.max(width * .85, columns * spacing / 2.4),
    perspective: Math.max(1200, width * 1.4), period: columns * spacing };
}

export const wrapPosition = (value, period) => ((value + period / 2) % period + period) % period - period / 2;

/** A center-out camera arrival layered over the existing wall-to-strip pose. */
export function loadPose(elapsed, index, width, height, progress = 0) {
  const { mobile, columns } = wallLayout(width, height);
  const row = Math.floor(index / columns) - 2;
  const column = index % columns - (columns - 1) / 2;
  const delay = .04 + Math.abs(column) / ((columns - 1) / 2) * .17 + Math.abs(row) * .05;
  const t = clamp((elapsed - delay) / 1.15);
  const arrive = 1 - (1 - t) ** 4;
  // Scrolling takes ownership immediately instead of fighting the load animation.
  const weight = 1 - phase(progress, .015, .18);
  const remaining = (1 - arrive) * weight;
  const settle = Math.sin(Math.PI * t) * (1 - t) ** 2 * weight;
  return {
    x: column * width * (mobile ? .11 : .13) * remaining,
    y: (row * height * .22 + height * .15) * remaining,
    z: -Math.min(1500, width * 1.05) * (mobile ? .7 : 1) * remaining + settle * 100,
    pitch: row * (mobile ? 12 : 18) * remaining,
    yaw: (column * 7 + (row === 0 ? -8 : 8)) * remaining,
    roll: (Math.sign(column) || row) * (mobile ? 4 : 7) * remaining,
    scale: 1 - .14 * remaining,
    opacity: lerp(phase(t, 0, .24), 1, 1 - weight),
  };
}

/** One pose owner for both the Burst cylinder and the settled Frieze strip. */
export function tilePose(index, selected, progress, width, height, drift = 0) {
  const { mobile, count, columns, cardWidth:wallWidth, cardHeight:wallHeight, gap, spacing, radius, period } = wallLayout(width, height);
  const row = Math.floor(index / columns);
  const column = index % columns - (columns - 1) / 2;
  const wrapped = wrapPosition(column * spacing + drift * (row % 2 ? -1 : 1) * (.86 + row * .07), period);
  const angle = wrapped / radius;
  const wallX = Math.sin(angle) * radius;
  const wallY = (row - 2) * (wallHeight + gap);
  const wallZ = (Math.cos(angle) - 1) * radius - 65;
  const wallOpacity = 1 - phase(Math.abs(wrapped) / (period / 2), .88, .98);
  const mix = phase(progress, .08, .74);
  const stripWidth = mobile ? 138 : Math.min(236, width * .165);
  const stripHeight = stripWidth * .64;
  const distance = index - selected;
  const stripX = distance * (stripWidth + (mobile ? 12 : 20));
  const stripY = height * (mobile ? .335 : .325);
  const stripYaw = clamp(distance * -7, -34, 34);
  const edgeOpacity = clamp(7 - Math.abs(distance), 0, 1);
  const route = Math.sin(mix * Math.PI) * (row - 2) * height * .055;
  return {
    x: lerp(wallX, stripX, mix),
    y: lerp(wallY, stripY, mix) + route,
    z: lerp(wallZ, -Math.abs(distance) * 15, mix),
    yaw: lerp(-angle * 180 / Math.PI, stripYaw, mix),
    width: wallWidth,
    height: wallHeight,
    scale: lerp(1, stripWidth / wallWidth, mix),
    opacity: lerp(wallOpacity, edgeOpacity, mix),
    stripHeight, count,
  };
}

export function sceneState(progress) {
  return {
    intro: 1 - phase(progress, .025, .2),
    product: phase(progress, .46, .75),
    device: phase(progress, .24, .7),
    rail: phase(progress, .65, .82),
    shade: lerp(.42, .08, phase(progress, .08, .72)),
  };
}
