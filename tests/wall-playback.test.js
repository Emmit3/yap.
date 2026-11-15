import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  initialReelIndex,
  reconcileWallVideo,
  firstPaintWatchdog,
  playbackRecoveryWindow,
} from '../public/motion.js';

test('a visible browser withholding its first RAF gets a static paint after 250ms', () => {
  let painted = false,
    renders = 0;
  const timers = new Map();
  const schedule = (callback, delay) => {
    timers.set(delay, callback);
    return delay;
  };
  const cancel = (timer) => timers.delete(timer);
  firstPaintWatchdog(
    () => painted,
    () => {
      painted = true;
      renders++;
    },
    schedule,
    cancel,
  );
  assert.equal(renders, 0);
  assert.equal(timers.has(250), true);
  timers.get(250)();
  assert.equal(renders, 1);
  timers.get(250)();
  assert.equal(renders, 1, 'a resumed browser cannot trigger a second fallback');
});

test('normal animation frames keep their entrance and cancel the fallback deadline', () => {
  let painted = false,
    fallbacks = 0;
  const timers = new Map();
  const stop = firstPaintWatchdog(
    () => painted,
    () => fallbacks++,
    (callback, delay) => {
      timers.set(delay, callback);
      return delay;
    },
    (timer) => timers.delete(timer),
  );
  painted = true;
  timers.get(250)();
  assert.equal(fallbacks, 0);
  stop();
  assert.equal(timers.size, 0);
});

function fixture(outcomes = []) {
  let calls = 0;
  const classes = new Set();
  const node = {
    paused: true,
    readyState: 4,
    src: '',
    getAttribute() {
      return this.src || null;
    },
    pause() {
      this.paused = true;
    },
    async play() {
      calls++;
      const error = outcomes.shift();
      if (error) throw Object.assign(new Error(error), { name: error });
      this.paused = false;
    },
  };
  return {
    entry: {
      node,
      tile: {
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
      },
      src: '/media/film.mp4',
      active: false,
      failed: false,
    },
    calls: () => calls,
    classes,
  };
}

test('the real desktop and mobile catalog open a video, while shared stills remain selected', async () => {
  const { clips } = JSON.parse(
    await readFile(new URL('../public/wall-media.json', import.meta.url), 'utf8'),
  );
  for (const count of [35, 65]) {
    const selected = initialReelIndex(clips, count);
    assert.ok(selected >= 0 && selected < count);
    assert.ok(clips[selected].video, 'the first phone selection can actually play');
    assert.equal(initialReelIndex(clips, count, 0), 0, 'a shared still is not silently replaced');
  }
  assert.equal(initialReelIndex([{ video: null }], 1), 0);
  assert.equal(initialReelIndex([], 0), -1);
});

test('an aborted play is retried after its delay, rather than stranded active and paused', async () => {
  const { entry, calls, classes } = fixture(['AbortError']);
  await reconcileWallVideo(entry, true, 0);
  assert.equal(entry.failed, false);
  assert.equal(calls(), 1);
  await reconcileWallVideo(entry, true, 100);
  assert.equal(calls(), 1);
  await reconcileWallVideo(entry, true, 600);
  assert.equal(calls(), 2);
  assert.equal(entry.node.paused, false);
  assert.ok(classes.has('is-playing'));
});

test('a suspended active video resumes, and explicit pause or media failure never starts it', async () => {
  const { entry, calls } = fixture();
  await reconcileWallVideo(entry, true, 0);
  entry.node.pause();
  await reconcileWallVideo(entry, true, 1000);
  assert.equal(calls(), 2);
  await reconcileWallVideo(entry, false, 1200, true);
  assert.equal(entry.node.paused, true);
  assert.equal(calls(), 2);
  entry.failed = true;
  await reconcileWallVideo(entry, true, 1400, true);
  assert.equal(calls(), 2);
});

test('autoplay denial waits for explicit foreground or resume reconciliation, without marking good media failed', async () => {
  const { entry, calls } = fixture(['NotAllowedError']);
  await reconcileWallVideo(entry, true, 0);
  await reconcileWallVideo(entry, true, 5000);
  assert.equal(calls(), 1);
  assert.equal(entry.failed, false);
  await reconcileWallVideo(entry, true, 6000, true);
  assert.equal(calls(), 2);
  assert.equal(entry.node.paused, false);
});

function fakeClock() {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    async advance(to) {
      time = to;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    pending: () => timers.size,
  };
}

test('startup retries an aborted play without RAF, honors pause, and ends after five seconds', async () => {
  const clock = fakeClock();
  const { entry, calls } = fixture(['AbortError']);
  let wanted = true;
  let ticks = 0;
  await reconcileWallVideo(entry, wanted, clock.now());
  playbackRecoveryWindow(
    () => {
      ticks++;
      return reconcileWallVideo(entry, wanted, clock.now(), false);
    },
    clock.now,
    clock.schedule,
    clock.cancel,
  );
  await clock.advance(500);
  assert.equal(calls(), 2);
  assert.equal(entry.node.paused, false);
  wanted = false;
  for (let time = 1000; time <= 5000; time += 500) await clock.advance(time);
  assert.equal(entry.node.paused, true);
  assert.equal(calls(), 2, 'timer cannot override pause intent');
  assert.equal(ticks, 10);
  assert.equal(clock.pending(), 0);
  await clock.advance(10000);
  assert.equal(ticks, 10, 'no permanent retry loop');
});

test('startup does not retry denied autoplay, run after suspension, or survive cancellation', async () => {
  const clock = fakeClock();
  const { entry, calls } = fixture(['NotAllowedError']);
  await reconcileWallVideo(entry, true, clock.now());
  const stop = playbackRecoveryWindow(
    () => reconcileWallVideo(entry, true, clock.now(), false),
    clock.now,
    clock.schedule,
    clock.cancel,
  );
  await clock.advance(500);
  assert.equal(calls(), 1);
  stop();
  assert.equal(clock.pending(), 0);
  let ticks = 0;
  playbackRecoveryWindow(() => ticks++, clock.now, clock.schedule, clock.cancel);
  await clock.advance(6500);
  assert.equal(ticks, 0, 'a throttled tab cannot extend the startup window');
  assert.equal(clock.pending(), 0);
});

test('native autoplay recovering after an aborted promise restores its visible video class', async () => {
  const { entry, calls, classes } = fixture(['AbortError']);
  await reconcileWallVideo(entry, true, 0);
  assert.equal(classes.has('is-playing'), false);
  entry.node.paused = false;
  await reconcileWallVideo(entry, true, 100);
  assert.equal(classes.has('is-playing'), true);
  assert.equal(calls(), 1, 'already playing media needs no second play promise');
});
