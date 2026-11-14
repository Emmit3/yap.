import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { isValidElement, type ReactElement } from 'react';
import ts from 'typescript';
import { rovingIndex } from '../src/creator/keyboard';
import { parseFilmCatalog } from '../src/creator/references';
import { referenceIdsFromMessage } from '../src/creation/bridge';
import { createReferenceCatalogReader } from '../src/creation/reference-loader';

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
type Props = { onDirty(value: boolean): void; onUseReferences(ids: string[]): void };
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Execute the actual parent component and callbacks without a browser. Child component
// identity/key and continued presence are the React contract for retaining their state.
function mount(props: Props) {
  let cursor = 0;
  const slots: Slot[] = [];
  let effects: Array<() => void> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const window = {
    location: { origin: 'https://yap.example' },
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  };
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
  const exported = { ReferenceRoom: (_props: Props): unknown => null };
  const mockRequire = (name: string) => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@phosphor-icons/react')
      return { ArrowUpRight: () => null, FilmSlate: () => null };
    if (name.endsWith('/references')) return { loadFilmCatalog: async () => films };
    if (name.endsWith('/keyboard')) return { rovingIndex };
    if (name.endsWith('/PosterWorkspace')) return { PosterWorkspace };
    if (name.endsWith('/bridge')) return { referenceIdsFromMessage };
    if (name.endsWith('/reference-loader')) return { createReferenceCatalogReader };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected component dependency: ${name}`);
  };
  new Function('require', 'exports', 'window', code)(mockRequire, exported, window);
  return {
    PosterWorkspace,
    listeners,
    window,
    render(next: Partial<Props> = {}) {
      props = { ...props, ...next };
      cursor = 0;
      const tree = exported.ReferenceRoom(props);
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return elements(tree);
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
  const room = mount({ onDirty: (value) => dirty.push(value), onUseReferences() {} });
  let tree = room.render();
  const poster = tree.find((node) => node.type === room.PosterWorkspace)!;
  const film = tree.find((node) => node.type === 'iframe')!;
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
  assert.equal(tree.find((node) => node.type === 'iframe')!.props.ref, film.props.ref);
  call(keptPoster.props.onDirty, true);
  call(byRole(tree, 'tab')[0]!.props.onClick);
  room.render();
  assert.deepEqual(dirty, [true]);
  assert.deepEqual(latest, [true], 'tab switches never clear the hidden poster draft guard');
  room.unmount();
  assert.deepEqual(latest, [true, false]);
});

test('reference tabs support roving arrows, Home and End while preserving native shortcuts', () => {
  const room = mount({ onDirty() {}, onUseReferences() {} });
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

test('the retained film frame still requires a trusted origin, source and known catalog ID', async () => {
  const used: string[][] = [];
  const room = mount({ onDirty() {}, onUseReferences: (ids) => used.push(ids) });
  let tree = room.render();
  const frame = tree.find((node) => node.type === 'iframe')!.props.ref;
  assert.ok(frame && typeof frame === 'object' && 'current' in frame);
  const source = {};
  frame.current = { contentWindow: source };
  await nextTick();
  const emit = (filmId: string, origin = room.window.location.origin, sender = source) =>
    call(room.listeners.get('message'), {
      origin,
      source: sender,
      data: { type: 'yap:film-reference', filmId },
    });
  emit(films[0]!.id, 'https://other.example');
  emit(films[0]!.id, room.window.location.origin, {});
  emit('unknown-film');
  await nextTick();
  assert.deepEqual(used, []);
  assert.equal(byRole(room.render(), 'alert').length, 1);
  emit(films[0]!.id);
  await nextTick();
  assert.deepEqual(used, [[films[0]!.id]]);
  tree = room.render();
  call(byRole(tree, 'tab')[1]!.props.onClick);
  tree = room.render();
  emit(films[0]!.id);
  await nextTick();
  assert.equal(used.length, 1);
  call(byRole(tree, 'tab')[0]!.props.onClick);
  room.render();
  emit(films[0]!.id);
  await nextTick();
  assert.equal(used.length, 2);
  room.unmount();
  assert.equal(room.listeners.has('message'), false);
});
