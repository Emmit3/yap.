const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));
const sizeOf = (count: number) => (Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0);
const wrap = (value: number, period: number) =>
  period > 0 ? ((((value + period / 2) % period) + period) % period) - period / 2 : 0;

export function posterIndex(position: number, count: number): number {
  const size = sizeOf(count);
  if (!size || !Number.isFinite(position)) return 0;
  return ((Math.round(position) % size) + size) % size;
}

export function posterDistance(index: number, position: number, count: number): number {
  const size = sizeOf(count);
  if (size < 2 || !Number.isFinite(index) || !Number.isFinite(position)) return 0;
  const distance = index - position;
  const result = wrap(distance, size);
  return result === -size / 2 && distance > 0 ? size / 2 : result;
}

/** Balanced portrait rows, using the landing's cylindrical wall rather than a card rail. */
export function posterCarouselLayout(viewportWidth: number, viewportHeight = 640, count = 22) {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1000;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 640;
  const size = sizeOf(count);
  const mobile = width < 700;
  const rows = Math.min(mobile ? 2 : 3, size);
  const rowCounts = Array.from(
    { length: rows },
    (_, row) => Math.floor(size / rows) + (row < size % rows ? 1 : 0),
  );
  const cardHeight =
    size === 1 ? Math.min(360, height * 0.68) : clamp((height - 72) / Math.max(1, rows), 150, 240);
  const cardWidth = Math.min(220, cardHeight * 0.72, width * 0.44);
  const spacing = cardWidth + (mobile ? 48 : 64);
  const columns = Math.max(1, ...rowCounts);
  return {
    width,
    height,
    count: size,
    mobile,
    rows,
    rowCounts,
    columns,
    cardWidth,
    cardHeight,
    spacing,
    rowSpacing: cardHeight + 40,
    radius: Math.max(620, width * 0.86, (columns * spacing) / 2.4),
    perspective: Math.max(1400, width * 1.6),
  };
}

export function posterWallCell(index: number, layout: ReturnType<typeof posterCarouselLayout>) {
  let local = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
  for (let row = 0; row < layout.rows; row++) {
    const columns = layout.rowCounts[row]!;
    if (local < columns)
      return {
        row,
        columns,
        column: local - (columns - 1) / 2,
        period: columns * layout.spacing,
        direction: (row % 2 ? -1 : 1) * (0.9 + row * 0.05),
        stagger: columns > 1 && row % 2 ? layout.spacing * 0.35 : 0,
      };
    local -= columns;
  }
  return { row: 0, columns: 1, column: 0, period: layout.spacing, direction: 0, stagger: 0 };
}

export function posterInitialIndex(count: number, width: number, height = 640) {
  const layout = posterCarouselLayout(width, height, count);
  const row = Math.floor(layout.rows / 2);
  return (
    layout.rowCounts.slice(0, row).reduce((sum, value) => sum + value, 0) +
    Math.floor((layout.rowCounts[row] ?? 0) / 2)
  );
}

/** Shift only the selected row, bringing any keyboard-selected poster fully into view. */
export function posterFocusOffset(
  index: number,
  ambient: number,
  count: number,
  width: number,
  height = 640,
  pan = 0,
  currentOffset = 0,
) {
  const layout = posterCarouselLayout(width, height, count);
  const cell = posterWallCell(index, layout);
  const base = cell.column * layout.spacing + cell.stagger + ambient * cell.direction + pan;
  return { row: cell.row, offset: currentOffset - wrap(base + currentOffset, cell.period) };
}

export function posterCarouselPose(
  index: number,
  ambient: number,
  count: number,
  viewportWidth: number,
  viewportHeight = 640,
  pan = 0,
  rowOffsets: readonly number[] = [],
) {
  const layout = posterCarouselLayout(viewportWidth, viewportHeight, count);
  const cell = posterWallCell(index, layout);
  const phase = Number.isFinite(ambient) ? ambient : 0;
  const horizontal = Number.isFinite(pan) ? pan : 0;
  const offset = Number.isFinite(rowOffsets[cell.row]) ? rowOffsets[cell.row]! : 0;
  const wrapped =
    cell.columns > 1
      ? wrap(
          cell.column * layout.spacing +
            cell.stagger +
            phase * cell.direction +
            horizontal +
            offset,
          cell.period,
        )
      : 0;
  const angle = wrapped / layout.radius;
  const edge = Math.abs(wrapped) / Math.max(1, cell.period / 2);
  const fade = cell.columns > 2 ? clamp((edge - 0.86) / 0.12, 0, 1) : 0;
  const opacity = 1 - fade * fade * (3 - 2 * fade);
  const float = Math.sin(index * 1.73 + phase / 180) * 10;
  const x = Math.sin(angle) * layout.radius;
  const y = (cell.row - (layout.rows - 1) / 2) * layout.rowSpacing + (count > 1 ? float : 0);
  const z = (Math.cos(angle) - 1) * layout.radius - (count > 1 ? 32 + (index % 4) * 12 : 0);
  const projection = layout.perspective / (layout.perspective - z);
  const projectedX = x * projection;
  const projectedY = y * projection;
  const visible =
    layout.count > 0 &&
    opacity > 0.04 &&
    Math.abs(projectedX) < layout.width / 2 + layout.cardWidth * projection * 0.3 &&
    Math.abs(projectedY) < layout.height / 2 + layout.cardHeight * projection * 0.3;
  return {
    ...layout,
    row: cell.row,
    x,
    y,
    z,
    projectedX,
    projectedY,
    yaw: clamp((-angle * 180) / Math.PI, -38, 38),
    roll: count > 1 ? [-4, 3, -2, 4, -3, 2][index % 6]! + Math.sin(phase / 220 + index) * 0.6 : 0,
    pitch: count > 1 ? (cell.row - (layout.rows - 1) / 2) * -2 : 0,
    scale: count > 1 ? 0.95 + (index % 5) * 0.025 : 1,
    opacity,
    visible,
    zIndex: 20 - Math.min(19, Math.round(-z / 40)),
  };
}

export function posterTransform(pose: ReturnType<typeof posterCarouselPose>) {
  return `translate(-50%, -50%) translate3d(${pose.x.toFixed(2)}px, ${pose.y.toFixed(2)}px, ${pose.z.toFixed(2)}px) rotateX(${pose.pitch.toFixed(2)}deg) rotateY(${pose.yaw.toFixed(2)}deg) rotateZ(${pose.roll.toFixed(2)}deg) scale(${pose.scale.toFixed(3)})`;
}
