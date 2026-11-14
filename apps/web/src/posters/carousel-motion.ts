const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const sizeOf = (count: number) => (Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0);

/** A stable catalog index, including after crossing either end of the ring. */
export function posterIndex(position: number, count: number): number {
  const size = sizeOf(count);
  if (!size || !Number.isFinite(position)) return 0;
  return ((Math.round(position) % size) + size) % size;
}

/** The shortest signed distance around the ring; the back seam stays out of view. */
export function posterDistance(index: number, position: number, count: number): number {
  const size = sizeOf(count);
  if (size < 2 || !Number.isFinite(index) || !Number.isFinite(position)) return 0;
  const distance = index - position;
  const half = size / 2;
  const wrapped = ((((distance + half) % size) + size) % size) - half;
  return wrapped === -half && distance > 0 ? half : wrapped;
}

export function posterCarouselLayout(viewportWidth: number) {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 800;
  const cardWidth = Math.min(220, Math.max(136, width * 0.26));
  return {
    cardWidth,
    cardHeight: Math.min(320, cardWidth * 1.46),
    spacing: cardWidth + (width < 600 ? 16 : 24),
    radius: Math.max(560, width * 0.72),
    perspective: Math.max(1000, width * 1.4),
  };
}

export function posterCarouselPose(
  index: number,
  position: number,
  count: number,
  viewportWidth: number,
) {
  const layout = posterCarouselLayout(viewportWidth);
  const distance = posterDistance(index, position, count);
  const away = Math.abs(distance);
  const angle = (distance * layout.spacing) / layout.radius;
  const fade = clamp((away - 2.5) / 1, 0, 1);
  const opacity = 1 - fade * fade * (3 - 2 * fade);
  return {
    ...layout,
    distance,
    x: Math.sin(angle) * layout.radius,
    y: Math.min(48, away * away * 6),
    z: (Math.cos(angle) - 1) * layout.radius - away * 8,
    yaw: (-angle * 180) / Math.PI,
    opacity,
    visible: sizeOf(count) > 0 && away < 3.5,
    zIndex: 10 - Math.min(9, Math.round(away)),
  };
}

export function posterTransform(pose: ReturnType<typeof posterCarouselPose>) {
  return `translate(-50%, -50%) translate3d(${pose.x.toFixed(2)}px, ${pose.y.toFixed(2)}px, ${pose.z.toFixed(2)}px) rotateY(${pose.yaw.toFixed(2)}deg)`;
}
