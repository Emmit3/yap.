import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CreatorPlan, CreatorVoice } from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import { ApiError } from './errors.js';
import { readBounded } from './creator-video-provider.js';

// Deprecated by OpenAI and scheduled to shut down on January 6, 2027. The named
// replacement runs on the Realtime API, which is a different transport.
export const CREATOR_VOICEOVER_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_CREATOR_VOICE: CreatorVoice = 'marin';
/** Conservative app ceiling per narrated line. The provider returns no usage to settle against. */
export const VOICEOVER_CENTS_PER_LINE = 10;
export const VOICEOVER_MAX_CHARACTERS = 1000;
// Comfortable narration is about 2.5 words per second; beyond this it cannot fit even sped up.
const MAX_WORDS_PER_SECOND = 2.8;
const TEMPOS = [1, 1.08, 1.16, 1.25];

const trackSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  title: z.string().min(1).max(200),
  mood: z.string().min(1).max(40),
  description: z.string().min(1).max(200),
  file: z.string().regex(/^[a-z0-9-]+\.m4a$/),
  seconds: z.number().positive(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CreatorMusicTrack = Pick<
  z.infer<typeof trackSchema>,
  'id' | 'title' | 'mood' | 'description' | 'seconds'
>;
export interface CreatorMusicLibrary {
  tracks: CreatorMusicTrack[];
  /** Absolute path of a track whose bytes matched the committed manifest at startup. */
  path(id: string): string;
}
export const DEFAULT_MUSIC_DIRECTORY = fileURLToPath(new URL('../assets/music/', import.meta.url));

/** Loads the bundled licensed tracks. A missing manifest means no music is offered. */
export async function loadCreatorMusic(
  directory = DEFAULT_MUSIC_DIRECTORY,
): Promise<CreatorMusicLibrary> {
  let manifest: string;
  try {
    manifest = await readFile(join(directory, 'credits.json'), 'utf8');
  } catch {
    return {
      tracks: [],
      path() {
        throw new ApiError(400, 'CREATOR_MUSIC_NOT_FOUND', 'This music track is not available.');
      },
    };
  }
  const tracks = z.object({ tracks: z.array(trackSchema).max(20) }).parse(JSON.parse(manifest));
  const paths = new Map<string, string>();
  for (const track of tracks.tracks) {
    const path = join(directory, track.file);
    const bytes = await readFile(path);
    if (
      bytes.length !== track.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== track.sha256
    )
      throw new Error(`Bundled music track ${track.id} does not match its credits manifest.`);
    paths.set(track.id, path);
  }
  return {
    tracks: tracks.tracks.map(({ id, title, mood, description, seconds }) => ({
      id,
      title,
      mood,
      description,
      seconds,
    })),
    path(id) {
      const path = paths.get(id);
      if (!path)
        throw new ApiError(400, 'CREATOR_MUSIC_NOT_FOUND', 'This music track is not available.');
      return path;
    },
  };
}
export function defaultMusicTrack(
  library: CreatorMusicLibrary,
  tone: string | undefined,
): string | null {
  const mood = tone === 'bold' ? 'upbeat' : tone === 'educational' ? 'modern' : 'calm';
  return (library.tracks.find((track) => track.mood === mood) ?? library.tracks[0])?.id ?? null;
}

export interface VoiceoverLine {
  segmentId: string;
  text: string;
  /** Where this line's scenes begin in the assembled film, in seconds. */
  start: number;
  /** Total time of the clips that show this line. */
  seconds: number;
}
/** The approved spoken lines, placed where their clips appear in the assembled film. */
export function voiceoverLines(plan: CreatorPlan, workflow: Workflow): VoiceoverLine[] {
  if (!plan.audio?.voice || !workflow.script || !workflow.scenes) return [];
  const segmentByScene = new Map(
    workflow.scenes.scenes.map((scene) => [scene.id, scene.scriptSegmentId]),
  );
  const slots = new Map<string, { start: number; seconds: number }>();
  let at = 0;
  for (const clip of plan.clips) {
    const segmentId = segmentByScene.get(clip.sceneId);
    if (segmentId) {
      const slot = slots.get(segmentId);
      if (slot) slot.seconds += clip.seconds;
      else slots.set(segmentId, { start: at, seconds: clip.seconds });
    }
    at += clip.seconds;
  }
  return workflow.script.segments
    .flatMap((segment) => {
      const slot = slots.get(segment.id),
        text = segment.text.trim();
      return slot && text ? [{ segmentId: segment.id, text, ...slot }] : [];
    })
    .sort((left, right) => left.start - right.start);
}
/**
 * One spoken line is recorded once and placed in one window, so every clip that shows it
 * must be consecutive. A, B, A cannot be narrated until the film has a timeline model.
 */
export function voiceoverContiguous(
  clips: Array<{ sceneId: string }>,
  workflow: Workflow,
): boolean {
  const segmentByScene = new Map(
    workflow.scenes?.scenes.map((scene) => [scene.id, scene.scriptSegmentId]),
  );
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const clip of clips) {
    const segmentId = segmentByScene.get(clip.sceneId);
    if (segmentId === previous) continue;
    if (segmentId) {
      if (seen.has(segmentId)) return false;
      seen.add(segmentId);
    }
    previous = segmentId;
  }
  return true;
}
export function assertVoiceoverContiguous(plan: CreatorPlan, workflow: Workflow): void {
  if (plan.audio?.voice && !voiceoverContiguous(plan.clips, workflow))
    throw new ApiError(
      400,
      'CREATOR_VOICEOVER_ORDER',
      'Narration needs every clip of one spoken line to play back to back. Reorder the clips so each line stays together, or turn narration off.',
    );
}
/** Rejects narration that cannot fit before any paid request is quoted. */
export function assertVoiceoverFits(lines: VoiceoverLine[], total: number): void {
  if (lines.some((line) => line.text.length > VOICEOVER_MAX_CHARACTERS))
    throw new ApiError(
      400,
      'CREATOR_VOICEOVER_TOO_LONG',
      `Keep each spoken line within ${VOICEOVER_MAX_CHARACTERS} characters.`,
    );
  const words = lines.reduce((sum, line) => sum + line.text.split(/\s+/).length, 0);
  if (words > Math.floor(total * MAX_WORDS_PER_SECOND))
    throw new ApiError(
      400,
      'CREATOR_VOICEOVER_TOO_LONG',
      `The script has ${words} spoken words for a ${total}-second film. Shorten it to about ${Math.floor(total * 2.4)} words, or turn narration off.`,
    );
}
/**
 * Places recorded lines without overlap. A line starts with its scene, or right after the
 * previous line when that one ran long. Speech is sped up only as far as needed, at most 25%.
 */
export function layoutVoiceover(
  lines: Array<{ start: number; duration: number }>,
  total: number,
): Array<{ at: number; tempo: number }> {
  for (const tempo of TEMPOS) {
    const placed: Array<{ at: number; tempo: number }> = [];
    let end = 0;
    for (const line of lines) {
      const at = Math.max(line.start + 0.2, placed.length ? end + 0.12 : 0);
      end = at + line.duration / tempo;
      placed.push({ at, tempo });
    }
    if (end <= total - 0.1) return placed;
  }
  throw new ApiError(
    422,
    'CREATOR_VOICEOVER_TOO_LONG',
    'The recorded narration is longer than the film. Shorten the script or turn narration off, then review a new quote.',
  );
}

export interface CreatorVoiceover {
  configured: boolean;
  /**
   * One paid request per line, in order, never retried. Returns WAV bytes per line.
   * `beforeSubmit` must run immediately before each request leaves: the caller treats its
   * first completed run as the point where narration may have been billed.
   */
  narrate(
    lines: string[],
    voice: CreatorVoice,
    tone: string | undefined,
    signal: AbortSignal,
    beforeSubmit?: () => Promise<void>,
  ): Promise<Buffer[]>;
}
export function createCreatorVoiceover(
  config: { apiKey?: string } = {},
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): CreatorVoiceover {
  return {
    configured: Boolean(config.apiKey?.trim()),
    async narrate(lines, voice, tone, external, beforeSubmit) {
      if (!config.apiKey?.trim())
        throw new ApiError(
          503,
          'CREATOR_VOICEOVER_NOT_CONFIGURED',
          'Set OPENAI_API_KEY to record narration, or turn narration off.',
        );
      const style =
        tone === 'bold'
          ? 'Confident, energetic promo narration with clear emphasis.'
          : tone === 'educational'
            ? 'Clear, friendly explainer narration at an even pace.'
            : 'Warm, natural, conversational narration, like recommending a favorite place to a friend.';
      const recorded: Buffer[] = [];
      for (const text of lines) {
        const signal = AbortSignal.any([external, AbortSignal.timeout(90000)]);
        await beforeSubmit?.();
        external.throwIfAborted();
        let response: Response;
        try {
          response = await fetcher('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey.trim()}`,
              'Content-Type': 'application/json',
            },
            signal,
            redirect: 'error',
            body: JSON.stringify({
              model: CREATOR_VOICEOVER_MODEL,
              input: text,
              voice,
              instructions: `${style} Brisk and concise. Read the text exactly as written.`,
              response_format: 'wav',
            }),
          });
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (external.aborted)
            throw new ApiError(409, 'CREATOR_CANCELED', 'Creation was canceled.');
          throw new ApiError(
            502,
            'CREATOR_VOICEOVER_FAILED',
            'The narration request did not complete. It may still be billed and was not repeated.',
          );
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          const rejected = [400, 401, 403, 404, 429].includes(response.status);
          throw new ApiError(
            502,
            // Only a definite rejection of the very first line proves nothing was billed.
            rejected && recorded.length === 0
              ? 'CREATOR_VOICEOVER_REJECTED'
              : 'CREATOR_VOICEOVER_FAILED',
            response.status === 401 || response.status === 403
              ? 'OpenAI rejected the API key for narration. No narration was recorded.'
              : response.status === 429
                ? 'OpenAI rate-limited or declined the narration request for this account.'
                : response.status === 404 || response.status === 400
                  ? `OpenAI did not accept the ${CREATOR_VOICEOVER_MODEL} narration request for this account.`
                  : 'The narration provider failed. The request was not repeated.',
          );
        }
        // Sixty seconds of 24 kHz mono speech is under 3 MB.
        const bytes = await readBounded(response, 20 * 1024 * 1024, signal);
        if (bytes.length < 1000 || bytes.subarray(0, 4).toString('latin1') !== 'RIFF')
          throw new ApiError(
            502,
            'CREATOR_VOICEOVER_FAILED',
            'The narration provider returned audio that could not be used.',
          );
        recorded.push(bytes);
      }
      return recorded;
    },
  };
}
