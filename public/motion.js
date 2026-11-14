export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
export const lerp = (from, to, progress) => from + (to - from) * progress;
export const smooth = (value) => { const t = clamp(value); return t * t * (3 - 2 * t); };
export const phase = (progress, from, to) => smooth((progress - from) / (to - from));

/** One pose owner for both the Burst cylinder and the settled Frieze strip. */
export function tilePose(index, selected, progress, width, height, drift = 0) {
  const mobile = width < 700;
  const count = mobile ? 15 : 21;
  const columns = mobile ? 5 : 7;
  const row = Math.floor(index / columns);
  const column = index % columns - (columns - 1) / 2;
  const wallWidth = mobile ? width * .46 : Math.min(380, width * .255);
  const wallHeight = wallWidth * .64;
  const angle = column * (mobile ? .33 : .31) + drift * (row % 2 ? -1 : 1);
  const radius = wallWidth * (mobile ? 3.2 : 3.5);
  const wallX = Math.sin(angle) * radius;
  const wallY = (row - 1) * (wallHeight + (mobile ? 18 : 28));
  const wallZ = (Math.cos(angle) - 1) * radius - 65;
  const mix = phase(progress, .08, .74);
  const stripWidth = mobile ? 138 : Math.min(236, width * .165);
  const stripHeight = stripWidth * .64;
  const distance = index - selected;
  const stripX = distance * (stripWidth + (mobile ? 12 : 20));
  const stripY = height * (mobile ? .335 : .325);
  const stripYaw = clamp(distance * -7, -34, 34);
  const edgeOpacity = clamp(7 - Math.abs(distance), 0, 1);
  const route = Math.sin(mix * Math.PI) * (row - 1) * height * .11;
  return {
    x: lerp(wallX, stripX, mix),
    y: lerp(wallY, stripY, mix) + route,
    z: lerp(wallZ, -Math.abs(distance) * 15, mix),
    yaw: lerp(-angle * 180 / Math.PI, stripYaw, mix),
    width: wallWidth,
    height: wallHeight,
    scale: lerp(1, stripWidth / wallWidth, mix),
    opacity: lerp(1, edgeOpacity, mix),
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
