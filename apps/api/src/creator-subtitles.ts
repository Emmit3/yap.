import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CreatorJob, CreatorPlan } from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import { ApiError } from './errors.js';
import type { BrandSnapshot } from '@yap/contracts/production';
import { subtitleStyle } from './creator-brand.js';

export interface SubtitleWindow {
  segmentId: string;
  text: string;
  start: number;
  end: number;
}
export interface CreatorSubtitleSnapshot {
  schemaVersion: 1;
  planId: string;
  workflowVersion: number;
  scriptId: string;
  timingSource: 'narration' | 'scene';
  /** Exact approved source text and measured windows, before display wrapping. */
  windows: SubtitleWindow[];
  cues: Array<{ segmentId: string; startMs: number; endMs: number; text: string }>;
}
export const SUBTITLE_FILENAME = 'subtitles.srt';
export const SUBTITLE_MAX_BYTES = 128 * 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const glyphs = (text: string) => [...graphemes.segment(text)].map(({ segment }) => segment);
const width = (text: string) =>
  glyphs(text).reduce(
    // Conservative Arial advances in half-em units; wide ASCII must not be
    // treated like average letters. Unknown fallback glyphs get extra space.
    (sum, glyph) =>
      sum +
      (/\p{Extended_Pictographic}/u.test(glyph)
        ? 4
        : /^[\x20-\x7e]$/u.test(glyph)
          ? /[MW@%&#]/u.test(glyph)
            ? 2
            : /[mwA-Z]/u.test(glyph)
              ? 1.7
              : /[il1.,'!:;|]/u.test(glyph)
                ? 0.7
                : 1.3
          : 2.2),
    0,
  );
const cannotFit = () =>
  new ApiError(
    422,
    'CREATOR_SUBTITLES_TOO_DENSE',
    'The approved text cannot fit readable subtitles. Shorten the script, allow more time, or turn subtitles off and review a new quote.',
  );

/** Explicit line breaks keep one bounded, readable style in the burn-in and SRT. */
function phrases(text: string): string[] {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(normalized))
    throw cannotFit();
  const lines: string[] = [];
  let line = '';
  for (const word of normalized.split(' ')) {
    if (width(word) > 32) {
      if (line) lines.push(line);
      line = '';
      for (const glyph of glyphs(word)) {
        if (width(line + glyph) > 32) {
          lines.push(line);
          line = '';
        }
        line += glyph;
      }
    } else if (line && width(`${line} ${word}`) > 32) {
      lines.push(line);
      line = word;
    } else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 2)
    result.push(lines.slice(index, index + 2).join('\n'));
  return result;
}

/** Actual ordered clip windows; repeated adjacent clips of the same line share a window. */
export function sceneSubtitleWindows(plan: CreatorPlan, workflow: Workflow): SubtitleWindow[] {
  const result: SubtitleWindow[] = [];
  let at = 0;
  for (const clip of plan.clips) {
    const scene = workflow.scenes?.scenes.find(({ id }) => id === clip.sceneId);
    const segment = workflow.script?.segments.find(({ id }) => id === scene?.scriptSegmentId);
    if (!segment?.text.trim()) throw cannotFit();
    const previous = result.at(-1);
    if (previous?.segmentId === segment.id) previous.end += clip.seconds;
    else
      result.push({ segmentId: segment.id, text: segment.text, start: at, end: at + clip.seconds });
    at += clip.seconds;
  }
  return result;
}

/** Phrase timing is derived within the measured line window, never claimed as word alignment. */
export function createSubtitleSnapshot(
  plan: CreatorPlan,
  workflow: Workflow,
  narration?: SubtitleWindow[],
): CreatorSubtitleSnapshot {
  const totalMs = plan.clips.reduce((sum, clip) => sum + clip.seconds * 1000, 0);
  const cues: CreatorSubtitleSnapshot['cues'] = [];
  const windows = narration ?? sceneSubtitleWindows(plan, workflow);
  for (const window of windows) {
    // ASS uses centiseconds; one shared rounding makes the SRT and burn-in identical.
    const startMs = Math.round(window.start * 100) * 10,
      endMs = Math.round(window.end * 100) * 10;
    const parts = phrases(window.text);
    const lengths = parts.map((part) => glyphs(part.replaceAll('\n', ' ')).length);
    const length = lengths.reduce((sum, count) => sum + count, 0);
    const minimums = lengths.map((count) => Math.max(600, (count / 22) * 1000));
    const required = minimums.reduce((sum, ms) => sum + ms, 0);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs > totalMs ||
      endMs <= startMs ||
      startMs < (cues.at(-1)?.endMs ?? 0) ||
      length / ((endMs - startMs) / 1000) > 22 ||
      required > endMs - startMs
    )
      throw cannotFit();
    let used = 0;
    parts.forEach((text, index) => {
      const from = startMs + Math.round(used / 10) * 10;
      used += minimums[index]! + ((endMs - startMs - required) * lengths[index]!) / length;
      const to = index === parts.length - 1 ? endMs : startMs + Math.round(used / 10) * 10;
      if (to - from < 590) throw cannotFit();
      cues.push({ segmentId: window.segmentId, startMs: from, endMs: to, text });
    });
  }
  if (!cues.length || cues.length > 240 || !workflow.script) throw cannotFit();
  return {
    schemaVersion: 1,
    planId: plan.id,
    workflowVersion: workflow.version,
    scriptId: workflow.script.id,
    timingSource: narration ? 'narration' : 'scene',
    windows,
    cues,
  };
}
function timestamp(ms: number): string {
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function subtitleSrt(snapshot: CreatorSubtitleSnapshot): string {
  return snapshot.cues
    .map(
      (cue, index) =>
        `${index + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${cue.text}\n`,
    )
    .join('\n');
}
export function subtitleAss(
  snapshot: CreatorSubtitleSnapshot,
  options?: { brand?: BrandSnapshot; width?: number; height?: number },
): string {
  const width = options?.width ?? 1080,
    height = options?.height ?? 1920;
  const style = options?.brand
    ? subtitleStyle(options.brand)
    : {
        fontName: 'Arial',
        fontSize: 54,
        primaryColor: '&H00FFFFFF',
        outlineColor: '&H00101010',
        outline: 3,
      };
  const scale = width > height ? height / 1080 : width / 1080;
  const fontSize = Math.max(18, Math.round(style.fontSize * scale));
  const margin = Math.round((width * 96) / 1080),
    bottom = Math.round(height * (width > height ? 0.08 : 280 / 1920));
  // libass recognizes escaped braces. A zero-width word joiner after creator
  // backslashes prevents literal \\N / \\h from becoming layout commands.
  const literal = (text: string) =>
    text
      .replaceAll('\\', '\\\u2060')
      .replaceAll('{', '\\{')
      .replaceAll('}', '\\}')
      .replaceAll('\n', '\\N');
  const time = (ms: number) => timestamp(ms).replace(',', '.').slice(0, -1);
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${style.fontName},${fontSize},${style.primaryColor},${style.primaryColor},${style.outlineColor},${style.outlineColor},0,0,0,0,100,100,0,0,1,${style.outline},1,2,${margin},${margin},${bottom},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    snapshot.cues
      .map(
        (cue) =>
          `Dialogue: 0,${time(cue.startMs)},${time(cue.endMs)},Default,,0,0,0,,${literal(cue.text)}\n`,
      )
      .join('')
  );
}
export async function writeCreatorSubtitles(
  directory: string,
  snapshot: CreatorSubtitleSnapshot,
  options?: { brand?: BrandSnapshot; width?: number; height?: number },
): Promise<NonNullable<NonNullable<CreatorJob['output']>['subtitles']>> {
  const bytes = Buffer.from(subtitleSrt(snapshot), 'utf8');
  if (!bytes.length || bytes.length > SUBTITLE_MAX_BYTES) throw cannotFit();
  await writeFile(join(directory, 'subtitle-cues.json'), JSON.stringify(snapshot), 'utf8');
  await writeFile(join(directory, SUBTITLE_FILENAME), bytes);
  await writeFile(join(directory, 'subtitles.ass'), subtitleAss(snapshot, options), 'utf8');
  return {
    format: 'srt',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    cueCount: snapshot.cues.length,
    timingSource: snapshot.timingSource,
  };
}
