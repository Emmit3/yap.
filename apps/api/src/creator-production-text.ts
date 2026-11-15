/** Text overlays use libass, available in the bundled encoder on every platform.
 * Linux ffmpeg-static does not include the drawtext filter. */
export interface ProductionTextLayer {
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  fontName: string;
  fontSize: number;
  color: string;
  alignment: 'top-left' | 'center';
  box?: { color: string; opacity: number; padding: number };
}

export function productionTextEmWidth(value: string): number {
  return [...value].reduce(
    (sum, character) =>
      sum +
      (/\p{Extended_Pictographic}/u.test(character)
        ? 1.6
        : /[MW@%&#]/u.test(character)
          ? 1
          : /^[\x20-\x7e]$/u.test(character)
            ? 0.7
            : 1.2),
    0,
  );
}

export function clampProductionText(
  layer: ProductionTextLayer,
  width: number,
  height: number,
): ProductionTextLayer {
  const lines = layer.text.split('\n'),
    textWidth = Math.max(...lines.map(productionTextEmWidth)) * layer.fontSize,
    textHeight = lines.length * layer.fontSize * 1.35;
  // The wrapping and placement share conservative glyph advances. Avoid a
  // separate native font-metrics engine on the encoder's headless platforms.
  return {
    ...layer,
    x: Math.max(16, Math.min(width - textWidth - 16, layer.x - textWidth / 2)),
    y: Math.max(16, Math.min(height - textHeight - 16, layer.y - textHeight / 2)),
    alignment: 'top-left',
  };
}

function color(hex: string, opacity = 1): string {
  const alpha = Math.round((1 - opacity) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
}

function time(seconds: number): string {
  const ticks = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}

function literal(text: string): string {
  // Match subtitle escaping: creator text cannot introduce ASS commands.
  return text
    .replaceAll('\\', '\\\u2060')
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll('\n', '\\N');
}

export function productionTextAss(
  width: number,
  height: number,
  layers: ProductionTextLayer[],
): string {
  const styles = layers.map((layer, index) => {
    const primary = color(layer.color),
      background = layer.box ? color(layer.box.color, layer.box.opacity) : color('#000000', 0);
    return `Style: Text${index},${layer.fontName},${layer.fontSize},${primary},${primary},${background},${background},0,0,0,0,100,100,0,0,${layer.box ? 3 : 1},${layer.box?.padding ?? 0},0,${layer.alignment === 'center' ? 5 : 7},0,0,0,1`;
  });
  const events = layers.map(
    (layer, index) =>
      `Dialogue: ${index},${time(layer.start)},${time(layer.end)},Text${index},,0,0,0,,{\\pos(${Math.round(layer.x)},${Math.round(layer.y)})}${literal(layer.text)}`,
  );
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}
