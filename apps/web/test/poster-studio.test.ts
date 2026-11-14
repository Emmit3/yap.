import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { isValidElement, type ReactElement } from 'react';
import type { PosterDesign, PosterStyle } from '@yap/contracts/posters';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/posters/PosterStudio.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const styles: PosterStyle[] = [
  {
    id: 'open-fields',
    title: 'Open fields',
    category: 'party',
    source: { url: 'https://www.instagram.com/reel/DfVgIHsB1sk/', timestampSeconds: 6 },
    imageUrl: `/api/posters/references/open-fields/image?sha256=${'a'.repeat(64)}`,
    crop: { width: 255, height: 453, sha256: 'a'.repeat(64) },
  },
  {
    id: 'afterimage',
    title: 'Afterimage',
    category: 'music',
    source: { url: 'https://www.instagram.com/reel/DfVgIHsB1sk/', timestampSeconds: 8 },
    imageUrl: `/api/posters/references/afterimage/image?sha256=${'b'.repeat(64)}`,
    crop: { width: 176, height: 260, sha256: 'b'.repeat(64) },
  },
];
const storageKey = 'yap.poster.last-design';
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
const savedDesign = (style: PosterStyle, changes: string): PosterDesign => ({
  id: '402d96fe-e91e-46e1-8b6c-787b995ff659',
  style,
  changes,
  status: 'prepared',
  createdAt: '2026-11-14T18:00:00.000Z',
});

type Node = ReactElement<Record<string, unknown>>;
type Slot = { initialized?: boolean; value?: unknown; deps?: unknown[]; cleanup?: () => void };
type Props = { onDirty(value: boolean): void; active?: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Execute the component's actual hooks, JSX and callbacks. The carousel is a boundary:
// these tests drive its public selection callback rather than reimplementing its motion.
function mount(restoredDesign?: PosterDesign) {
  let cursor = 0;
  const slots: Slot[] = [];
  let effects: Array<() => void> = [];
  const dirty: boolean[] = [];
  const storage = new Map<string, string>();
  if (restoredDesign) storage.set(storageKey, restoredDesign.id);
  const saves: Array<{
    args: unknown[];
    result: ReturnType<typeof deferred<{ design: PosterDesign }>>;
  }> = [];
  const reads: Array<{ id: string; signal: AbortSignal }> = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const window = {
    addEventListener(name: string, listener: (event: unknown) => void) {
      const registered = listeners.get(name) ?? new Set();
      registered.add(listener);
      listeners.set(name, registered);
    },
    removeEventListener(name: string, listener: (event: unknown) => void) {
      const registered = listeners.get(name);
      registered?.delete(listener);
      if (!registered?.size) listeners.delete(name);
    },
  };
  const slot = () => slots[cursor] ?? (slots[cursor] = { value: undefined });
  const take = () => {
    const item = slot();
    cursor++;
    return item;
  };
  const changed = (item: Slot, deps: unknown[]) =>
    !item.deps ||
    deps.length !== item.deps.length ||
    deps.some((value, index) => value !== item.deps![index]);
  const hooks = {
    useState(initial: unknown) {
      const item = take();
      if (!item.initialized) {
        item.value = typeof initial === 'function' ? initial() : initial;
        item.initialized = true;
      }
      return [
        item.value,
        (next: unknown) => {
          item.value = typeof next === 'function' ? next(item.value) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const item = take();
      if (!item.initialized) {
        item.value = { current: initial };
        item.initialized = true;
      }
      return item.value;
    },
    useMemo(factory: () => unknown, deps: unknown[]) {
      const item = take();
      if (changed(item, deps)) {
        item.value = factory();
        item.deps = deps;
      }
      return item.value;
    },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const item = take();
      if (changed(item, deps)) {
        item.deps = deps;
        effects.push(() => {
          item.cleanup?.();
          const cleanup = effect();
          item.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
        });
      }
    },
    useLayoutEffect() {
      // Native dialog/FLIP geometry is exercised by browser smoke coverage.
      take();
    },
  };
  function PosterCarousel() {
    return null;
  }
  const api = {
    styles: async () => ({ styles }),
    createDesign(...args: unknown[]) {
      const result = deferred<{ design: PosterDesign }>();
      saves.push({ args, result });
      return result.promise;
    },
    async getDesign(id: string, signal: AbortSignal) {
      reads.push({ id, signal });
      if (!restoredDesign) throw new Error('No saved design.');
      return { design: restoredDesign };
    },
    imageUrl: (value: string) => value,
  };
  const exported = { PosterWorkspace: (_props: Props): unknown => null };
  const mockRequire = (name: string) => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@phosphor-icons/react')
      return {
        ArrowLeft: () => null,
        ArrowUpRight: () => null,
        Check: () => null,
        MagnifyingGlass: () => null,
        Sparkle: () => null,
      };
    if (name === './PosterCarousel') return { PosterCarousel };
    if (name === './api') return { posterApi: api };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected poster studio dependency: ${name}`);
  };
  const props: Props = { onDirty: (value) => dirty.push(value), active: true };
  new Function(
    'require',
    'exports',
    'document',
    'HTMLElement',
    'requestAnimationFrame',
    'sessionStorage',
    'window',
    code,
  )(
    mockRequire,
    exported,
    { activeElement: null },
    class HTMLElement {},
    (callback: () => void) => callback(),
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    window,
  );
  const instance = {
    PosterCarousel,
    dirty,
    storage,
    saves,
    reads,
    listeners,
    emit(name: string, event: unknown = {}) {
      listeners.get(name)?.forEach((listener) => listener(event));
    },
    render(next: Partial<Props> = {}) {
      Object.assign(props, next);
      cursor = 0;
      const tree = exported.PosterWorkspace(props);
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
      return elements(tree);
    },
    async load() {
      instance.render();
      await nextTick();
      return instance.render();
    },
    unmount() {
      slots.forEach((item) => item.cleanup?.());
    },
  };
  return instance;
}

function elements(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  return isValidElement<Record<string, unknown>>(value)
    ? [value, ...elements(value.props.children)]
    : [];
}
function words(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(words).join(' ');
  return isValidElement<Record<string, unknown>>(value) ? words(value.props.children) : '';
}
function call(value: unknown, ...args: unknown[]) {
  assert.equal(typeof value, 'function');
  if (typeof value === 'function') return value(...args);
}
function editor(tree: Node[]) {
  const dialog = tree.find((node) => node.type === 'dialog');
  assert.ok(dialog, 'choosing a style opens its customization dialog');
  return elements(dialog);
}
function textarea(tree: Node[]) {
  const field = editor(tree).find((node) => node.type === 'textarea');
  assert.ok(field);
  return field;
}
function choose(studio: ReturnType<typeof mount>, tree: Node[], style: PosterStyle) {
  const carousel = tree.find((node) => node.type === studio.PosterCarousel);
  assert.ok(carousel);
  call(carousel.props.onOpen, style);
  return studio.render();
}
function edit(studio: ReturnType<typeof mount>, tree: Node[], changes: string) {
  call(textarea(tree).props.onChange, { target: { value: changes } });
  return studio.render();
}
function submit(tree: Node[]) {
  const form = editor(tree).find((node) => node.type === 'form');
  assert.ok(form);
  let prevented = false;
  call(form.props.onSubmit, {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
}
function back(studio: ReturnType<typeof mount>, tree: Node[]) {
  const button = editor(tree).find(
    (node) => node.type === 'button' && words(node).trim() === 'All styles',
  );
  assert.ok(button);
  call(button.props.onClick);
  return studio.render();
}
function savedStatus(tree: Node[]) {
  return editor(tree).find((node) => node.props.role === 'status');
}

test('selecting a style saves only its public identity, crop hash and requested changes', async () => {
  const studio = mount();
  try {
    let tree = choose(studio, await studio.load(), styles[0]!);
    assert.equal(textarea(tree).props.value, '');
    assert.equal(editor(tree).find((node) => node.type === 'img')?.props.src, styles[0]!.imageUrl);
    assert.equal(editor(tree).filter((node) => node.type === 'textarea').length, 1);
    assert.doesNotMatch(
      words(editor(tree)[0]),
      /sha256|manifest|reconstruction|prompt template|system prompt/i,
    );
    assert.equal(studio.dirty.at(-1), false);

    tree = edit(studio, tree, '  Add Night Garden, June 8 at the Glasshouse. Use deep blue.  ');
    assert.equal(studio.dirty.at(-1), true);
    assert.equal(savedStatus(tree), undefined);
    submit(tree);
    tree = studio.render();
    assert.equal(savedStatus(tree), undefined, 'a request in flight is not a saved receipt');
    assert.equal(studio.saves.length, 1);
    const request = studio.saves[0]!;
    assert.equal(request.args.length, 4);
    assert.deepEqual(request.args.slice(0, 3), [
      styles[0]!.id,
      'Add Night Garden, June 8 at the Glasshouse. Use deep blue.',
      styles[0]!.crop.sha256,
    ]);
    assert.ok(request.args[3] instanceof AbortSignal);
    const receipt = savedDesign(styles[0]!, String(request.args[1]));
    request.result.resolve({ design: receipt });
    await nextTick();
    tree = studio.render();
    assert.equal(studio.dirty.at(-1), false);
    assert.equal(
      studio.storage.get(storageKey),
      receipt.id,
      'the returned public receipt is retained',
    );
    assert.match(words(savedStatus(tree)), /Your direction is saved/);
    assert.equal(
      editor(tree).find((node) => node.type === 'button' && node.props.type === 'submit')?.props
        .disabled,
      true,
    );
  } finally {
    studio.unmount();
  }
});

test('edits made during an asynchronous save survive its stale receipt and stay unsaved', async () => {
  const studio = mount();
  try {
    let tree = choose(studio, await studio.load(), styles[0]!);
    tree = edit(studio, tree, 'Use blue for the June event.');
    submit(tree);
    tree = studio.render();
    tree = edit(studio, tree, 'Use green instead, and make the headline larger.');
    const first = studio.saves[0]!;
    first.result.resolve({ design: savedDesign(styles[0]!, 'Use blue for the June event.') });
    await nextTick();
    tree = studio.render();
    assert.equal(textarea(tree).props.value, 'Use green instead, and make the headline larger.');
    assert.equal(studio.dirty.at(-1), true);
    assert.equal(
      savedStatus(tree),
      undefined,
      'an older receipt cannot mark newer requested changes saved',
    );
    assert.equal(
      editor(tree).find((node) => node.type === 'button' && node.props.type === 'submit')?.props
        .disabled,
      false,
    );

    submit(tree);
    const second = studio.saves[1]!;
    assert.equal(second.args[1], 'Use green instead, and make the headline larger.');
    second.result.resolve({ design: savedDesign(styles[0]!, String(second.args[1])) });
    await nextTick();
    tree = studio.render();
    assert.equal(studio.dirty.at(-1), false);
    assert.ok(savedStatus(tree));
  } finally {
    studio.unmount();
  }
});

test('back, choosing another style and hiding the workspace preserve each unsaved draft', async () => {
  const studio = mount();
  try {
    let tree = choose(studio, await studio.load(), styles[0]!);
    tree = edit(studio, tree, 'First draft: a blue garden party.');
    tree = back(studio, tree);
    assert.equal(
      tree.some((node) => node.type === 'dialog'),
      false,
    );
    tree = choose(studio, tree, styles[1]!);
    assert.equal(
      textarea(tree).props.value,
      '',
      'a new style does not inherit another style’s copy',
    );
    tree = edit(studio, tree, 'Second draft: a silver music poster.');
    tree = back(studio, tree);
    tree = choose(studio, tree, styles[0]!);
    assert.equal(textarea(tree).props.value, 'First draft: a blue garden party.');
    studio.render({ active: false });
    tree = studio.render({ active: true });
    assert.equal(textarea(tree).props.value, 'First draft: a blue garden party.');
    assert.equal(studio.dirty.at(-1), true);
    tree = back(studio, tree);
    tree = choose(studio, tree, styles[1]!);
    assert.equal(textarea(tree).props.value, 'Second draft: a silver music poster.');
    assert.equal(studio.saves.length, 0);
  } finally {
    studio.unmount();
  }
});

test('restoration accepts a matching public saved design and ignores a stale crop version', async () => {
  const receipt = savedDesign(styles[1]!, 'Keep our saved purple concert direction.');
  const studio = mount(receipt);
  try {
    let tree = await studio.load();
    assert.equal(studio.reads[0]?.id, receipt.id);
    assert.ok(studio.reads[0]?.signal instanceof AbortSignal);
    tree = choose(studio, tree, styles[1]!);
    assert.equal(textarea(tree).props.value, receipt.changes);
    assert.ok(savedStatus(tree));
    assert.equal(studio.dirty.at(-1), false);
  } finally {
    studio.unmount();
  }

  const stale = mount({
    ...receipt,
    style: { ...receipt.style, crop: { ...receipt.style.crop, sha256: 'c'.repeat(64) } },
  });
  try {
    const tree = choose(stale, await stale.load(), styles[1]!);
    assert.equal(textarea(tree).props.value, '');
    assert.equal(savedStatus(tree), undefined);
    assert.equal(stale.dirty.at(-1), false);
  } finally {
    stale.unmount();
  }
});

test('a browser hash change closes customization while retaining the dirty style draft', async () => {
  const studio = mount();
  try {
    let tree = choose(studio, await studio.load(), styles[0]!);
    tree = edit(studio, tree, 'Keep the garden party draft when I use browser Back.');
    assert.equal(studio.dirty.at(-1), true);
    assert.ok(
      studio.listeners.get('hashchange')?.size,
      'the editor observes browser route changes',
    );

    studio.emit('hashchange', {
      oldURL: 'https://yap.example/#/references',
      newURL: 'https://yap.example/#/create',
    });
    tree = studio.render();
    assert.equal(
      tree.some((node) => node.type === 'dialog'),
      false,
    );
    assert.ok(tree.find((node) => node.type === studio.PosterCarousel));
    assert.equal(studio.dirty.at(-1), true, 'closing the modal leaves the App draft guard active');

    tree = choose(studio, tree, styles[0]!);
    assert.equal(
      textarea(tree).props.value,
      'Keep the garden party draft when I use browser Back.',
    );
    assert.equal(savedStatus(tree), undefined);
    assert.equal(studio.saves.length, 0);
  } finally {
    studio.unmount();
  }
  assert.equal(studio.listeners.has('hashchange'), false, 'unmount removes the route listener');
});
