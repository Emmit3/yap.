import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { isValidElement, type ReactElement } from 'react';
import ts from 'typescript';
import { rovingIndex } from '../src/creator/keyboard';
import { parseFilmCatalog } from '../src/creator/references';

const require = createRequire(import.meta.url);
const source = await readFile(
  new URL('../src/creation/ReferenceRoom.tsx', import.meta.url),
  'utf8',
);
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const films = parseFilmCatalog(
  JSON.parse(
    await readFile(new URL('../../../public/film-references.json', import.meta.url), 'utf8'),
  ),
);
type Slot = { value: unknown; deps?: unknown[]; cleanup?: () => void };
type Props = {
  onDirty(value: boolean): void;
  onUseReferences(ids: string[]): void;
  posters: boolean;
};

// Execute the actual parent component and callbacks without a browser. Child component
// identity/key and continued presence are the React contract for retaining their state.
function mount(props: Props) {
  let cursor = 0;
  const slots: Slot[] = [];
  let effects: Array<() => void> = [];
  const slot = () => {
    const index = cursor++;
    return slots[index] ?? (slots[index] = { value: undefined });
  };
  const changed = (item: Slot, deps: unknown[]) =>
    !item.deps || deps.some((value, index) => value !== item.deps![index]);
  const hooks = {
    useState(initial: unknown) {
      const item = slot();
      if (!item.deps) {
        item.value = typeof initial === 'function' ? initial() : initial;
        item.deps = [];
      }
      return [
        item.value,
        (next: unknown) => {
          item.value = typeof next === 'function' ? next(item.value) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const item = slot();
      if (!item.deps) {
        item.value = { current: initial };
        item.deps = [];
      }
      return item.value;
    },
    useId() {
      const item = slot();
      item.value ??= 'reference-test';
      return item.value;
    },
    useCallback(callback: unknown, deps: unknown[]) {
      const item = slot();
      if (changed(item, deps)) {
        item.value = callback;
        item.deps = deps;
      }
      return item.value;
    },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const item = slot();
      if (changed(item, deps)) {
        item.deps = deps;
        effects.push(() => {
          item.cleanup?.();
          const cleanup = effect();
          item.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
        });
      }
    },
  };
  function PosterWorkspace() {
    return null;
  }
  function ProductGallery() {
    return null;
  }
  const icons = { DotsThree: () => null, X: () => null };
  const focusEvents: string[] = [];
  const navigationButton = {
    focus(options: { preventScroll: boolean }) {
      assert.equal(options.preventScroll, true);
      focusEvents.push('navigation');
    },
  };
  const navigationToggle = {
    focus(options: { preventScroll: boolean }) {
      assert.equal(options.preventScroll, true);
      focusEvents.push('toggle');
    },
  };
  const browserWindow = new EventTarget();
  const browserDocument = {
    querySelector(selector: string) {
      assert.equal(selector, '.side-nav button');
      return navigationButton;
    },
  };
  const exported = { ReferenceRoom: (_props: Props): unknown => null };
  const mockRequire = (name: string) => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@phosphor-icons/react') return icons;
    if (name.endsWith('/keyboard')) return { rovingIndex };
    if (name.endsWith('/PosterWorkspace')) return { PosterWorkspace };
    if (name.endsWith('/ProductGallery')) return { ProductGallery };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected component dependency: ${name}`);
  };
  new Function('require', 'exports', 'document', 'window', code)(
    mockRequire,
    exported,
    browserDocument,
    browserWindow,
  );
  return {
    PosterWorkspace,
    ProductGallery,
    focusEvents,
    navigationKey(key: string) {
      const event = new Event('keydown');
      Object.defineProperty(event, 'key', { value: key });
      browserWindow.dispatchEvent(event);
    },
    render(next: Partial<Props> = {}) {
      props = { ...props, ...next };
      cursor = 0;
      const tree = elements(exported.ReferenceRoom(props));
      for (const node of tree) {
        if (node.props.className !== 'inspiration-menu-toggle') continue;
        const ref = node.props.ref;
        if (ref && typeof ref === 'object' && 'current' in ref) ref.current = navigationToggle;
      }
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return tree;
    },
    unmount() {
      slots.forEach((item) => item.cleanup?.());
    },
  };
}
function elements(value: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isValidElement<Record<string, unknown>>(value)
    ? [value, ...elements(value.props.children)]
    : [];
}
function byRole(tree: ReturnType<typeof elements>, role: string) {
  return tree.filter((node) => node.props.role === role);
}
function call(value: unknown, ...args: unknown[]) {
  assert.equal(typeof value, 'function');
  if (typeof value === 'function') value(...args);
}

test('switching reference tabs retains both child trees and a stable poster dirty callback', () => {
  const dirty: boolean[] = [],
    latest: boolean[] = [];
  const room = mount({
    onDirty: (value) => dirty.push(value),
    onUseReferences() {},
    posters: true,
  });
  let tree = room.render();
  const poster = tree.find((node) => node.type === room.PosterWorkspace)!;
  const gallery = tree.find((node) => node.type === room.ProductGallery)!;
  assert.equal(gallery.props.active, true);
  assert.deepEqual(
    byRole(tree, 'tabpanel').map((node) => node.props.hidden),
    [false, true],
  );
  call(poster.props.onDirty, true);
  call(byRole(tree, 'tab')[1]!.props.onClick);
  tree = room.render({ onDirty: (value) => latest.push(value) });
  assert.deepEqual(
    byRole(tree, 'tabpanel').map((node) => node.props.hidden),
    [true, false],
  );
  const keptPoster = tree.find((node) => node.type === room.PosterWorkspace)!;
  assert.equal(keptPoster.key, poster.key);
  assert.equal(keptPoster.props.onDirty, poster.props.onDirty);
  const keptGallery = tree.find((node) => node.type === room.ProductGallery)!;
  assert.equal(keptGallery.key, gallery.key);
  assert.equal(keptGallery.props.active, false);
  call(keptPoster.props.onDirty, true);
  call(byRole(tree, 'tab')[0]!.props.onClick);
  room.render();
  assert.deepEqual(dirty, [true]);
  assert.deepEqual(latest, [true], 'tab switches never clear the hidden poster draft guard');
  room.unmount();
  assert.deepEqual(latest, [true, false]);
});

test('reference tabs support roving arrows, Home and End while preserving native shortcuts', () => {
  const room = mount({ onDirty() {}, onUseReferences() {}, posters: true });
  let tree = room.render();
  let focused = -1,
    prevented = 0;
  const key = (name: string, altKey = false) => {
    call(byRole(tree, 'tablist')[0]!.props.onKeyDown, {
      key: name,
      altKey,
      ctrlKey: false,
      metaKey: false,
      preventDefault() {
        prevented++;
      },
      currentTarget: {
        querySelectorAll: () =>
          [0, 1].map((index) => ({
            focus() {
              focused = index;
            },
          })),
      },
    });
    tree = room.render();
  };
  assert.deepEqual(
    byRole(tree, 'tab').map((node) => node.props.tabIndex),
    [0, -1],
  );
  key('End');
  assert.equal(focused, 1);
  assert.deepEqual(
    byRole(tree, 'tab').map((node) => node.props.tabIndex),
    [-1, 0],
  );
  key('ArrowRight');
  assert.equal(focused, 0);
  key('ArrowLeft');
  assert.equal(focused, 1);
  key('Home');
  assert.equal(focused, 0);
  key('Tab');
  key('ArrowRight', true);
  assert.equal(prevented, 4);
  room.unmount();
});

test('workspace navigation toggling preserves child identity and the hidden draft guard, with Escape focus recovery', () => {
  const dirty: boolean[] = [];
  const room = mount({
    onDirty: (value) => dirty.push(value),
    onUseReferences() {},
    posters: true,
  });
  let tree = room.render();
  const poster = tree.find((node) => node.type === room.PosterWorkspace)!;
  const gallery = tree.find((node) => node.type === room.ProductGallery)!;
  const toggle = () => tree.find((node) => node.props.className === 'inspiration-menu-toggle')!;
  const roomNode = () => tree.find((node) => node.props.className === 'creation-reference-room')!;
  assert.equal(toggle().props['aria-expanded'], false);
  call(poster.props.onDirty, true);
  call(toggle().props.onClick);
  tree = room.render();
  assert.equal(toggle().props['aria-expanded'], true);
  assert.equal(roomNode().props['data-navigation-open'], true);
  assert.deepEqual(room.focusEvents, ['navigation']);
  const posterWhileOpen = tree.find((node) => node.type === room.PosterWorkspace)!;
  assert.equal(posterWhileOpen.key, poster.key);
  assert.equal(posterWhileOpen.props.onDirty, poster.props.onDirty);
  assert.equal(tree.find((node) => node.type === room.ProductGallery)!.key, gallery.key);
  call(byRole(tree, 'tab')[1]!.props.onClick);
  tree = room.render();
  assert.equal(tree.find((node) => node.type === room.PosterWorkspace)!.props.active, true);
  assert.equal(tree.find((node) => node.type === room.ProductGallery)!.props.active, false);
  assert.equal(toggle().props['aria-expanded'], true);
  room.navigationKey('Enter');
  assert.deepEqual(room.focusEvents, ['navigation']);
  room.navigationKey('Escape');
  tree = room.render();
  assert.equal(toggle().props['aria-expanded'], false);
  assert.equal(roomNode().props['data-navigation-open'], undefined);
  assert.deepEqual(room.focusEvents, ['navigation', 'toggle']);
  assert.equal(
    tree.find((node) => node.type === room.PosterWorkspace)!.props.onDirty,
    poster.props.onDirty,
  );
  assert.deepEqual(
    byRole(tree, 'tabpanel').map((node) => node.props.hidden),
    [true, false],
  );
  assert.deepEqual(dirty, [true], 'opening or closing navigation does not discard poster changes');
  room.navigationKey('Escape');
  assert.deepEqual(
    room.focusEvents,
    ['navigation', 'toggle'],
    'the closed menu removes its keyboard listener',
  );
  room.unmount();
  assert.deepEqual(dirty, [true, false]);
});

test('native product inspiration forwards selected source IDs without a full-page film iframe', () => {
  const used: string[][] = [];
  const room = mount({ onDirty() {}, onUseReferences: (ids) => used.push(ids), posters: true });
  let tree = room.render();
  const gallery = tree.find((node) => node.type === room.ProductGallery)!;
  assert.equal(
    tree.some((node) => node.type === 'iframe'),
    false,
  );
  call(gallery.props.onUseReferences, [films[0]!.id]);
  assert.deepEqual(used, [[films[0]!.id]]);
  call(byRole(tree, 'tab')[1]!.props.onClick);
  tree = room.render();
  assert.equal(tree.find((node) => node.type === room.ProductGallery)!.props.active, false);
  call(byRole(tree, 'tab')[0]!.props.onClick);
  tree = room.render();
  assert.equal(tree.find((node) => node.type === room.ProductGallery)!.props.active, true);
  room.unmount();
});

test('a server without poster styles shows videos only, with no empty Posters tab', () => {
  const room = mount({ onDirty() {}, onUseReferences() {}, posters: false });
  const tree = room.render();
  assert.equal(byRole(tree, 'tablist').length, 0);
  assert.equal(byRole(tree, 'tab').length, 0);
  assert.equal(byRole(tree, 'tabpanel').length, 0);
  assert.equal(
    tree.find((node) => node.type === room.PosterWorkspace),
    undefined,
  );
  assert.equal(tree.find((node) => node.type === room.ProductGallery)!.props.active, true);
  room.unmount();
});
