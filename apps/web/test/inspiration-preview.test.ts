import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactElement } from 'react';
import ts from 'typescript';
import { playableClip, publicMediaUrl, type ClipPreview } from '../src/inspiration/catalog.js';
import { FilmPreview } from '../src/inspiration/FilmPreview.js';
import {
  filmPlaybackUrl,
  type VisibleClipPreviewOptions,
} from '../src/inspiration/preview-playback.js';

const require = createRequire(import.meta.url);
const source = 'https://example.com/original-film';
const vimeo: ClipPreview = {
  kind: 'embed',
  provider: 'Vimeo',
  src: 'https://player.vimeo.com/video/1238004406?h=2573484b0e&dnt=1&autoplay=1&muted=1',
  sourceUrl: source,
};
const youtube: ClipPreview = {
  kind: 'embed',
  provider: 'YouTube',
  src: 'https://www.youtube-nocookie.com/embed/fMMXpBKzMuc?rel=0&autoplay=1&mute=1',
  sourceUrl: source,
};
const mux: ClipPreview = {
  kind: 'embed',
  provider: 'Mux',
  src: 'https://player.mux.com/j1ppGEgL3KUlOWbx02UzLWDt7zL4M2QiI4KAJ4o700Y100?autoplay=true&muted=true',
  sourceUrl: source,
};
const video: ClipPreview = {
  kind: 'video',
  provider: 'Original source',
  src: 'https://example.com/film.mp4',
  poster: 'https://example.com/film.jpg',
  sourceUrl: source,
};

test('previews retain Vimeo unlisted access and privacy while allowing simultaneous muted loops', () => {
  const url = new URL(filmPlaybackUrl(vimeo)!);
  assert.equal(url.origin, 'https://player.vimeo.com');
  for (const [key, value] of Object.entries({
    h: '2573484b0e',
    autoplay: '1',
    muted: '1',
    loop: '1',
    controls: '0',
    autopause: '0',
    dnt: '1',
  }))
    assert.equal(url.searchParams.get(key), value);
  assert.equal(
    filmPlaybackUrl(vimeo, false),
    vimeo.src,
    'focused playback must keep the original full-player URL',
  );
});

test('YouTube previews use its privacy host and a same-video loop; Mux uses supported background parameters', () => {
  const yt = new URL(filmPlaybackUrl(youtube)!);
  assert.equal(yt.hostname, 'www.youtube-nocookie.com');
  for (const [key, value] of Object.entries({
    autoplay: '1',
    mute: '1',
    controls: '0',
    loop: '1',
    playlist: 'fMMXpBKzMuc',
    playsinline: '1',
  }))
    assert.equal(yt.searchParams.get(key), value);
  const mx = new URL(filmPlaybackUrl(mux)!);
  for (const [key, value] of Object.entries({
    autoplay: 'true',
    muted: 'true',
    loop: 'true',
    controls: 'false',
  }))
    assert.equal(mx.searchParams.get(key), value);
  assert.equal(filmPlaybackUrl(youtube, false), youtube.src);
  assert.equal(filmPlaybackUrl(mux, false), mux.src);
});

test('only validated public player hosts and stable direct videos become media URLs', () => {
  for (const src of [
    'javascript:alert(1)',
    'http://player.vimeo.com/video/123456',
    'https://player.vimeo.com.evil.com/video/123456',
    'https://user:password@player.vimeo.com/video/123456',
    'https://player.vimeo.com:444/video/123456',
    'https://player.vimeo.com/video/123456?h=not-valid',
    'https://www.youtube.com/watch?v=fMMXpBKzMuc',
  ]) {
    assert.equal(filmPlaybackUrl({ ...vimeo, src }), null, src);
    assert.equal(filmPlaybackUrl({ ...vimeo, src }, false), null, src);
  }
  assert.equal(filmPlaybackUrl(video), video.src);
  assert.equal(
    filmPlaybackUrl({ ...video, src: 'https://example.com/film.mp4?token=private' }),
    null,
  );
  assert.equal(filmPlaybackUrl({ ...video, src: 'https://127.0.0.1/film.mp4' }), null);
});

test('inactive renderers mount no iframe or video; previews cannot capture tile interaction', () => {
  for (const clip of [vimeo, youtube, mux, video]) {
    assert.equal(
      renderToStaticMarkup(createElement(FilmPreview, { clip, active: false, label: 'Film' })),
      '',
    );
    const html = renderToStaticMarkup(
      createElement(FilmPreview, { clip, active: true, label: 'Film' }),
    );
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /tabindex="-1"/);
    assert.match(html, /pointer-events:none/);
    if (clip.kind === 'video') {
      assert.match(html, /muted=""/);
      assert.match(html, /loop=""/);
      assert.doesNotMatch(html, / controls=/);
    }
  }
  const full = renderToStaticMarkup(
    createElement(FilmPreview, { clip: video, active: true, label: 'Full film', preview: false }),
  );
  assert.match(full, /controls=""/);
  assert.match(full, /aria-label="Full film"/);
  assert.doesNotMatch(full, /aria-hidden|pointer-events:none| loop=/);
});

type Slot = { initialized?: boolean; value?: unknown; deps?: unknown[]; cleanup?: () => void };
type HookResult = {
  refFor(id: string): (node: HTMLElement | null) => void;
  activeIds: Set<string>;
  reducedMotion: boolean;
};
const playbackCode = ts.transpileModule(
  await readFile(new URL('../src/inspiration/preview-playback.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const rendererCode = ts.transpileModule(
  await readFile(new URL('../src/inspiration/FilmPreview.tsx', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function hooks() {
  let cursor = 0;
  const slots: Slot[] = [];
  let pending: Array<() => void> = [];
  const take = () => slots[cursor] ?? (slots[cursor] = {});
  const next = () => {
    const value = take();
    cursor++;
    return value;
  };
  const changed = (slot: Slot, deps: unknown[]) =>
    !slot.deps ||
    deps.length !== slot.deps.length ||
    deps.some((dep, index) => dep !== slot.deps![index]);
  const useMemo = (factory: () => unknown, deps: unknown[]) => {
    const slot = next();
    if (changed(slot, deps)) {
      slot.value = factory();
      slot.deps = deps;
    }
    return slot.value;
  };
  return {
    api: {
      useState(initial: unknown) {
        const slot = next();
        if (!slot.initialized) {
          slot.value = typeof initial === 'function' ? initial() : initial;
          slot.initialized = true;
        }
        return [
          slot.value,
          (value: unknown) => {
            slot.value = typeof value === 'function' ? value(slot.value) : value;
          },
        ];
      },
      useRef(initial: unknown) {
        const slot = next();
        if (!slot.initialized) {
          slot.value = { current: initial };
          slot.initialized = true;
        }
        return slot.value;
      },
      useMemo,
      useCallback: (callback: unknown, deps: unknown[]) => useMemo(() => callback, deps),
      useEffect(effect: () => (() => void) | void, deps: unknown[]) {
        const slot = next();
        if (changed(slot, deps)) {
          slot.deps = deps;
          pending.push(() => {
            slot.cleanup?.();
            const cleanup = effect();
            slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
          });
        }
      },
    },
    begin() {
      cursor = 0;
    },
    flush() {
      const effects = pending;
      pending = [];
      effects.forEach((effect) => effect());
    },
    unmount() {
      slots.forEach((slot) => slot.cleanup?.());
    },
  };
}

function mountVisibility(initial: Partial<VisibleClipPreviewOptions> = {}) {
  const runtime = hooks();
  const document = Object.assign(new EventTarget(), { hidden: false });
  const media = Object.assign(new EventTarget(), { matches: false });
  const window = { matchMedia: () => media };
  const watches: Watch[] = [];
  class Watch {
    nodes = new Set<Element>();
    disconnected = false;
    constructor(
      readonly callback: IntersectionObserverCallback,
      readonly options: IntersectionObserverInit,
    ) {
      watches.push(this);
    }
    observe(node: Element) {
      this.nodes.add(node);
    }
    unobserve(node: Element) {
      this.nodes.delete(node);
    }
    disconnect() {
      this.disconnected = true;
      this.nodes.clear();
    }
    fire(entries: Array<{ node: HTMLElement; ratio: number; intersecting?: boolean }>) {
      this.callback(
        entries.map((entry) => ({
          target: entry.node,
          intersectionRatio: entry.ratio,
          isIntersecting: entry.intersecting ?? entry.ratio > 0,
        })) as IntersectionObserverEntry[],
        this as unknown as IntersectionObserver,
      );
    }
  }
  const exported = {
    useVisibleClipPreviews: (_props: VisibleClipPreviewOptions): HookResult => ({
      refFor: () => () => undefined,
      activeIds: new Set(),
      reducedMotion: false,
    }),
  };
  new Function('require', 'exports', 'window', 'document', 'IntersectionObserver', playbackCode)(
    (name: string) => {
      if (name === 'react') return runtime.api;
      if (name === './catalog') return { playableClip, publicMediaUrl };
      throw new Error(`Unexpected preview dependency: ${name}`);
    },
    exported,
    window,
    document,
    Watch,
  );
  const props: VisibleClipPreviewOptions = {
    ids: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
    active: true,
    suspended: false,
    paused: false,
    ...initial,
  };
  const nodes = new Map(props.ids.map((id) => [id, {} as HTMLElement]));
  const render = (next: Partial<VisibleClipPreviewOptions> = {}, flush = true) => {
    Object.assign(props, next);
    runtime.begin();
    const result = exported.useVisibleClipPreviews(props);
    if (flush) runtime.flush();
    return result;
  };
  const first = render();
  for (const [id, node] of nodes) first.refFor(id)(node);
  return {
    render,
    nodes,
    watches,
    media,
    document,
    flush: runtime.flush,
    unmount: runtime.unmount,
  };
}

test('the actual hook uses viewport clipping, hysteresis and a reading-order preview budget', () => {
  const app = mountVisibility();
  const watch = app.watches.at(-1)!;
  assert.equal(watch.options.root, null);
  assert.deepEqual(watch.options.threshold, [0, 0.35, 0.6, 1]);
  watch.fire([...app.nodes.values()].reverse().map((node) => ({ node, ratio: 0.59 })));
  assert.equal(app.render().activeIds.size, 0);
  watch.fire([...app.nodes.values()].reverse().map((node) => ({ node, ratio: 0.6 })));
  assert.deepEqual([...app.render().activeIds], ['one', 'two', 'three', 'four', 'five', 'six']);
  watch.fire([{ node: app.nodes.get('one')!, ratio: 0.4 }]);
  assert.equal(app.render().activeIds.has('one'), true);
  watch.fire([{ node: app.nodes.get('one')!, ratio: 0.34 }]);
  assert.deepEqual([...app.render().activeIds], ['two', 'three', 'four', 'five', 'six', 'seven']);
  app.unmount();
  assert.equal(watch.disconnected, true);
});

test('inactive room, detail view, pause, document hiding and reduced motion empty players immediately', () => {
  for (const reason of ['active', 'suspended', 'paused', 'hidden', 'reduced']) {
    const app = mountVisibility();
    const watch = app.watches.at(-1)!;
    watch.fire([{ node: app.nodes.get('one')!, ratio: 1 }]);
    assert.equal(app.render().activeIds.size, 1);
    let change: Partial<VisibleClipPreviewOptions> = {};
    if (reason === 'active') change = { active: false };
    if (reason === 'suspended') change = { suspended: true };
    if (reason === 'paused') change = { paused: true };
    if (reason === 'hidden') {
      app.document.hidden = true;
      app.document.dispatchEvent(new Event('visibilitychange'));
    }
    if (reason === 'reduced') {
      app.media.matches = true;
      app.media.dispatchEvent(new Event('change'));
    }
    const result = app.render(change, false);
    assert.equal(result.activeIds.size, 0, reason);
    assert.equal(watch.disconnected, false, 'the returned set must empty before passive cleanup');
    app.flush();
    assert.equal(watch.disconnected, true);
    if (reason === 'reduced') assert.equal(result.reducedMotion, true);
    app.unmount();
  }
});

test('filtered catalogs ignore old visibility callbacks and removed tile refs stop previews', () => {
  const app = mountVisibility();
  const old = app.watches.at(-1)!;
  old.fire([{ node: app.nodes.get('one')!, ratio: 1 }]);
  const first = app.render();
  const stableRef = first.refFor('one');
  assert.equal(app.render().refFor('one'), stableRef);
  assert.equal(app.render({ ids: ['one', 'two'] }).activeIds.size, 0);
  old.fire([{ node: app.nodes.get('one')!, ratio: 1 }]);
  assert.equal(app.render().activeIds.size, 0);
  const current = app.watches.at(-1)!;
  current.fire([{ node: app.nodes.get('one')!, ratio: 1 }]);
  assert.equal(app.render().activeIds.has('one'), true);
  stableRef(null);
  assert.equal(app.render().activeIds.size, 0);
  app.unmount();
});

test('resuming previews requires a fresh observation rather than a queued pre-pause callback', () => {
  const app = mountVisibility({ maxActive: 2 });
  const old = app.watches.at(-1)!;
  old.fire([...app.nodes.values()].map((node) => ({ node, ratio: 1 })));
  assert.deepEqual([...app.render().activeIds], ['one', 'two']);
  app.render({ paused: true });
  assert.equal(app.render({ paused: false }).activeIds.size, 0);
  old.fire([{ node: app.nodes.get('one')!, ratio: 1 }]);
  assert.equal(app.render().activeIds.size, 0);
  app.watches.at(-1)!.fire([{ node: app.nodes.get('three')!, ratio: 1 }]);
  assert.deepEqual([...app.render().activeIds], ['three']);
  app.unmount();
});

function mountVideo(preview = true, blocked = false) {
  const runtime = hooks();
  const exported = {
    FilmPreview: (_props: {
      clip: ClipPreview;
      active: boolean;
      label: string;
      preview: boolean;
    }): ReactElement<Record<string, unknown>> | null => null,
  };
  new Function('require', 'exports', rendererCode)((name: string) => {
    if (name === 'react') return runtime.api;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === './catalog') return { publicMediaUrl };
    if (name === './preview-playback') return { filmPlaybackUrl };
    throw new Error(`Unexpected media dependency: ${name}`);
  }, exported);
  const attrs = new Map([['src', video.src]]);
  const node = {
    defaultMuted: false,
    muted: false,
    plays: 0,
    pauses: 0,
    loads: 0,
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    removeAttribute: (name: string) => attrs.delete(name),
    play() {
      this.plays++;
      return blocked ? Promise.reject(new Error('Autoplay blocked')) : Promise.resolve();
    },
    pause() {
      this.pauses++;
    },
    load() {
      this.loads++;
    },
  };
  const props = { clip: video, active: true, label: 'Original film', preview };
  return {
    node,
    attrs,
    render(next: Partial<typeof props> = {}) {
      Object.assign(props, next);
      runtime.begin();
      const tree = exported.FilmPreview(props);
      if (tree) (tree.props.ref as { current: unknown }).current = node;
      runtime.flush();
      return tree;
    },
    unmount: runtime.unmount,
  };
}

test('native playback starts muted and releases its decoder when inactive', async () => {
  const app = mountVideo();
  app.render();
  assert.equal(app.node.defaultMuted, true);
  assert.equal(app.node.muted, true);
  assert.equal(app.node.plays, 1);
  assert.equal(app.render({ active: false }), null);
  assert.equal(app.node.pauses, 1);
  assert.equal(app.node.loads, 1);
  assert.equal(app.attrs.has('src'), false);
  await Promise.resolve();
  app.unmount();
});

test('blocked native autoplay exposes the poster for previews and keeps full-player controls', async () => {
  const preview = mountVideo(true, true);
  preview.render();
  await Promise.resolve();
  assert.equal(preview.render(), null);
  assert.equal(preview.node.pauses, 1);
  preview.unmount();
  const full = mountVideo(false, true);
  full.render();
  await Promise.resolve();
  const player = full.render();
  assert.equal(player?.props.controls, true);
  assert.equal(player?.props['data-autoplay-blocked'], true);
  full.unmount();
});
