import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/errors.js';
import {
  assertVoiceoverFits,
  createCreatorVoiceover,
  defaultMusicTrack,
  layoutVoiceover,
  loadCreatorMusic,
} from '../src/creator-audio.js';

test('recorded lines start with their scenes, never overlap and speed up only as needed', () => {
  assert.deepEqual(
    layoutVoiceover(
      [
        { start: 0, duration: 3 },
        { start: 5, duration: 4 },
      ],
      15,
    ),
    [
      { at: 0.2, tempo: 1 },
      { at: 5.2, tempo: 1 },
    ],
  );
  const late = layoutVoiceover(
    [
      { start: 0, duration: 6 },
      { start: 5, duration: 4 },
    ],
    15,
  );
  assert.equal(late[0]!.tempo, 1);
  assert.ok(Math.abs(late[1]!.at - 6.32) < 1e-9, 'an overrunning line delays the next one');
  const fast = layoutVoiceover([{ start: 0, duration: 16 }], 15);
  assert.ok(fast[0]!.tempo > 1 && fast[0]!.tempo <= 1.25);
  assert.throws(
    () => layoutVoiceover([{ start: 0, duration: 30 }], 15),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_VOICEOVER_TOO_LONG',
  );
});

test('a script too wordy for the film is rejected before anything is quoted', () => {
  const line = (words: number) => ({
    segmentId: 'a',
    text: Array.from({ length: words }, () => 'word').join(' '),
    start: 0,
    seconds: 15,
  });
  assert.doesNotThrow(() => assertVoiceoverFits([line(36)], 15));
  assert.throws(
    () => assertVoiceoverFits([line(60)], 15),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_VOICEOVER_TOO_LONG',
  );
});

test('bundled music matches its credits manifest and is chosen by tone', async () => {
  const library = await loadCreatorMusic();
  assert.deepEqual(library.tracks.map((track) => track.id).sort(), [
    'calm',
    'cinematic',
    'modern',
    'upbeat',
  ]);
  assert.ok(library.tracks.every((track) => track.seconds >= 60));
  assert.equal(defaultMusicTrack(library, 'bold'), 'upbeat');
  assert.equal(defaultMusicTrack(library, 'educational'), 'modern');
  assert.equal(defaultMusicTrack(library, undefined), 'calm');
  assert.throws(() => library.path('../credits'), ApiError);
  assert.deepEqual((await loadCreatorMusic('/nonexistent-yap-music')).tracks, []);
});

test('narration sends one bounded request per line and never retries a failure', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000)]);
  const voiceover = createCreatorVoiceover({ apiKey: 'fixture' }, async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/audio/speech');
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 3 ? new Response('{}', { status: 500 }) : new Response(wav);
  });
  const signal = new AbortController().signal;
  assert.equal((await voiceover.narrate(['One.', 'Two.'], 'cedar', 'bold', signal)).length, 2);
  assert.deepEqual(
    bodies.map((body) => [body.model, body.input, body.voice, body.response_format]),
    [
      ['gpt-4o-mini-tts', 'One.', 'cedar', 'wav'],
      ['gpt-4o-mini-tts', 'Two.', 'cedar', 'wav'],
    ],
  );
  await assert.rejects(
    voiceover.narrate(['Three.'], 'cedar', undefined, signal),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_VOICEOVER_FAILED',
  );
  assert.equal(bodies.length, 3);
  const rejected = createCreatorVoiceover(
    { apiKey: 'fixture' },
    async () => new Response('{}', { status: 401 }),
  );
  await assert.rejects(
    rejected.narrate(['One.'], 'marin', undefined, signal),
    (error: unknown) => error instanceof ApiError && error.code === 'CREATOR_VOICEOVER_REJECTED',
  );
  await assert.rejects(
    createCreatorVoiceover().narrate(['One.'], 'marin', undefined, signal),
    (error: unknown) =>
      error instanceof ApiError && error.code === 'CREATOR_VOICEOVER_NOT_CONFIGURED',
  );
});
