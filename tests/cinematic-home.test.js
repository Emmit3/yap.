import assert from 'node:assert/strict';
import test from 'node:test';
import { mountCinematicHome } from '../public/cinematic-home.js';

class Target {
  listeners = new Map();
  attributes = new Map();
  dataset = {};
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  emit(type) {
    for (const callback of [...(this.listeners.get(type) ?? [])]) callback({ type, target: this });
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0);
  }
}

function fixture({ reduced = false, saveData = false, play } = {}) {
  const document = new Target();
  document.hidden = false;
  document.body = new Target();
  const header = new Target();
  const headerLink = new Target();
  header.contains = (element) => element === headerLink;
  document.activeElement = document.body;
  document.querySelector = (selector) =>
    selector === '.site-head' ? header : document.dialogOpen ? {} : null;
  const window = new Target();
  document.defaultView = window;
  const motion = new Target();
  motion.matches = reduced;
  window.matchMedia = () => motion;
  const connection = new Target();
  connection.saveData = saveData;
  window.navigator = { connection };
  let intersection;
  let mutation;
  window.IntersectionObserver = class {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      intersection = this;
    }
    observe(node) {
      this.observed = node;
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  window.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      mutation = this;
    }
    observe(node, options) {
      this.observed = node;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  const video = new Target();
  video.paused = true;
  video.dataset.src = './media/reel-demo.mp4';
  video.playCount = 0;
  video.pauseCount = 0;
  Object.defineProperty(video, 'src', {
    set(value) {
      video.setAttribute('src', value);
    },
    get() {
      return video.getAttribute('src');
    },
  });
  video.play = () => {
    video.playCount++;
    if (play) return play(video);
    video.paused = false;
    return Promise.resolve();
  };
  video.pause = () => {
    video.paused = true;
    video.pauseCount++;
  };
  const pause = new Target();
  const pauseLabel = new Target();
  let labelText = '';
  let labelMutationPending = false;
  Object.defineProperty(pauseLabel, 'textContent', {
    get() {
      return labelText;
    },
    set(value) {
      labelText = value;
      // Setting textContent replaces text nodes even when the wording is unchanged.
      labelMutationPending = true;
    },
  });
  pause.querySelector = () => pauseLabel;
  const replay = new Target();
  const root = new Target();
  root.ownerDocument = document;
  const classes = new Set();
  root.classList = {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name),
  };
  root.querySelector = (selector) =>
    ({
      '.cinematic-home__video': video,
      '[data-home-pause]': pause,
      '[data-home-replay]': replay,
    })[selector] ?? null;
  const activeChanges = [];
  let replayCount = 0;
  const dispose = mountCinematicHome(root, {
    onReplay: () => replayCount++,
    onActiveChange: (active) => activeChanges.push(active),
  });
  return {
    root,
    video,
    pause,
    pauseLabel,
    replay,
    document,
    window,
    motion,
    connection,
    headerLink,
    activeChanges,
    intersection,
    mutation,
    dispose,
    get replayCount() {
      return replayCount;
    },
    intersect(ratio) {
      intersection.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]);
    },
    dialog(open) {
      document.dialogOpen = open;
      mutation.callback();
    },
    flushLabelMutations() {
      for (let count = 0; labelMutationPending && count < 8; count++) {
        labelMutationPending = false;
        mutation.callback([{ type: 'childList', target: pauseLabel }]);
      }
      assert.equal(
        labelMutationPending,
        false,
        'control text must not feed the dialog observer forever',
      );
    },
  };
}

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

test('the home lazily plays only in view, reveals actual frames and reports header visibility separately', async () => {
  const scene = fixture();
  assert.equal(scene.root.dataset.active, 'false');
  assert.equal(scene.video.src, null);
  assert.equal(scene.video.playCount, 0);
  assert.equal(scene.intersection.observed, scene.root);
  scene.intersect(0.54);
  await settle();
  assert.equal(scene.video.src, null);
  scene.intersect(0.6);
  await settle();
  assert.equal(scene.root.dataset.active, 'true');
  assert.equal(scene.video.src, './media/reel-demo.mp4');
  assert.equal(scene.video.muted, true);
  assert.equal(scene.video.playCount, 1);
  assert.deepEqual(scene.activeChanges, [], 'partial scene cannot suppress the main header');
  scene.video.emit('loadeddata');
  assert.equal(scene.root.classList.contains('is-playing'), false);
  scene.video.emit('playing');
  assert.equal(scene.root.classList.contains('is-playing'), true);
  scene.intersect(0.8);
  scene.intersect(0.9);
  assert.deepEqual(scene.activeChanges, [true]);
  assert.equal(scene.video.playCount, 1);
  scene.intersect(0.6);
  assert.deepEqual(scene.activeChanges, [true, false]);
  scene.intersect(0);
  assert.equal(scene.video.paused, true);
  assert.equal(scene.root.dataset.active, 'false');
  scene.dispose();
});

test('control text changes settle under the real body-subtree dialog observation contract', async () => {
  const scene = fixture();
  assert.equal(scene.mutation.observed, scene.document.body);
  assert.equal(scene.mutation.options.childList, true);
  assert.equal(scene.mutation.options.subtree, true);
  scene.flushLabelMutations();
  scene.intersect(0.8);
  await settle();
  scene.pause.emit('click');
  scene.flushLabelMutations();
  assert.equal(scene.pauseLabel.textContent, 'Play film');
  assert.equal(scene.video.playCount, 1);
  scene.pause.emit('click');
  await settle();
  scene.flushLabelMutations();
  assert.equal(scene.pauseLabel.textContent, 'Pause film');
  scene.dispose();
});

test('an explicit pause survives scrolling, tab changes, page suspension and motion preference changes', async () => {
  const scene = fixture();
  scene.intersect(0.8);
  await settle();
  scene.video.emit('playing');
  scene.pause.emit('click');
  assert.equal(scene.video.paused, true);
  assert.equal(scene.pause.getAttribute('aria-pressed'), 'true');
  assert.equal(scene.pauseLabel.textContent, 'Play film');
  assert.equal(
    scene.root.classList.contains('is-playing'),
    true,
    'pause keeps a frozen ready frame',
  );
  scene.intersect(0);
  scene.intersect(0.8);
  scene.document.hidden = true;
  scene.document.emit('visibilitychange');
  scene.document.hidden = false;
  scene.document.emit('visibilitychange');
  scene.window.emit('pagehide');
  scene.window.emit('pageshow');
  scene.motion.matches = true;
  scene.motion.emit('change');
  scene.motion.matches = false;
  scene.motion.emit('change');
  await settle();
  assert.equal(scene.video.playCount, 1);
  scene.pause.emit('click');
  await settle();
  assert.equal(scene.video.playCount, 2);
  assert.equal(scene.pause.getAttribute('aria-pressed'), 'false');
  scene.dispose();
});

test('reduced motion and data saver retain the poster without loading a video', async () => {
  for (const settings of [{ reduced: true }, { saveData: true }]) {
    const scene = fixture(settings);
    scene.intersect(1);
    scene.pause.emit('click');
    await settle();
    assert.equal(scene.video.src, null);
    assert.equal(scene.video.playCount, 0);
    assert.equal(scene.pause.disabled, true);
    assert.equal(scene.pauseLabel.textContent, 'Motion off');
    scene.replay.emit('click');
    assert.equal(scene.replayCount, 1, 'other controls remain usable with a static poster');
    scene.motion.matches = false;
    scene.connection.saveData = false;
    scene.motion.emit('change');
    await settle();
    assert.equal(scene.video.playCount, 1);
    assert.equal(scene.pause.disabled, false);
    scene.connection.saveData = true;
    scene.connection.emit('change');
    assert.equal(scene.video.paused, true);
    scene.dispose();
  }
});

test('background activity stops for hidden pages and dialogs, and never hides a focused header', async () => {
  const scene = fixture();
  scene.intersect(0.8);
  await settle();
  scene.document.hidden = true;
  scene.document.emit('visibilitychange');
  assert.equal(scene.video.paused, true);
  assert.equal(scene.activeChanges.at(-1), false);
  scene.document.hidden = false;
  scene.document.emit('visibilitychange');
  await settle();
  assert.equal(scene.video.playCount, 2);
  scene.dialog(true);
  assert.equal(scene.video.paused, true);
  assert.equal(scene.activeChanges.at(-1), false);
  scene.dialog(false);
  await settle();
  assert.equal(scene.video.playCount, 3);
  scene.document.activeElement = scene.headerLink;
  scene.document.emit('focusin');
  assert.equal(scene.activeChanges.at(-1), false);
  assert.equal(
    scene.video.paused,
    false,
    'header focus does not needlessly interrupt the backdrop',
  );
  scene.document.activeElement = scene.document.body;
  scene.document.emit('focusout');
  await settle();
  assert.equal(scene.activeChanges.at(-1), true);
  scene.window.emit('pagehide');
  assert.equal(scene.video.paused, true);
  scene.window.emit('pageshow');
  await settle();
  assert.equal(scene.video.playCount, 4);
  assert.equal(scene.replayCount, 0, 'visibility never advances or replays the opening');
  scene.dispose();
});

test('rejected autoplay keeps the poster and waits for a user retry; failed media never claims readiness', async () => {
  const scene = fixture({
    play: (video) => {
      if (video.playCount === 1) return Promise.reject(new Error('Autoplay denied'));
      video.paused = false;
      return Promise.resolve();
    },
  });
  scene.intersect(0.8);
  await settle();
  assert.equal(scene.video.playCount, 1);
  assert.equal(scene.root.classList.contains('is-playing'), false);
  assert.equal(scene.pauseLabel.textContent, 'Play film');
  scene.intersect(0.9);
  scene.document.emit('focusin');
  scene.mutation.callback();
  await settle();
  assert.equal(scene.video.playCount, 1, 'failed autoplay has no polling or observer retry loop');
  scene.pause.emit('click');
  await settle();
  assert.equal(scene.video.playCount, 2);
  scene.video.emit('playing');
  assert.equal(scene.root.classList.contains('is-playing'), true);
  scene.video.emit('error');
  assert.equal(scene.video.paused, true);
  assert.equal(scene.root.classList.contains('is-playing'), false);
  assert.equal(scene.pauseLabel.textContent, 'Film unavailable');
  scene.video.emit('playing');
  assert.equal(
    scene.root.classList.contains('is-playing'),
    false,
    'late events cannot reveal failed media',
  );
  scene.intersect(0);
  scene.intersect(0.8);
  scene.pause.emit('click');
  await settle();
  assert.equal(scene.video.playCount, 2);
  scene.dispose();
});

test('disposing removes every observer and listener and defeats an outstanding play request', async () => {
  let resolvePlay;
  const scene = fixture({
    play: (video) =>
      new Promise((resolve) => {
        resolvePlay = () => {
          video.paused = false;
          resolve();
        };
      }),
  });
  scene.intersect(0.8);
  await settle();
  assert.equal(scene.video.playCount, 1);
  scene.dispose();
  scene.dispose();
  assert.equal(scene.intersection.disconnected, true);
  assert.equal(scene.mutation.disconnected, true);
  for (const target of [
    scene.video,
    scene.pause,
    scene.replay,
    scene.document,
    scene.window,
    scene.motion,
    scene.connection,
  ])
    assert.equal(target.listenerCount(), 0);
  resolvePlay();
  scene.video.emit('playing');
  scene.document.emit('visibilitychange');
  scene.window.emit('pageshow');
  await settle();
  assert.equal(scene.video.paused, true);
  assert.equal(scene.video.playCount, 1);
  assert.equal(scene.root.dataset.active, 'false');
  assert.equal(scene.root.classList.contains('is-playing'), false);
  assert.deepEqual(scene.activeChanges, [true, false]);
  assert.doesNotThrow(() => mountCinematicHome(null)());
});
