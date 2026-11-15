import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../public/film-references-core.js';

const film = (id) => ({
  id,
  title: `Original film ${id}`,
  brand: 'Original brand',
  creator: 'Original studio',
  category: 'Audio',
  product: 'Speaker',
  url: `https://creator.example/films/${id}`,
  watchUrl: `https://vimeo.com/${id}`,
  videoEvidence: 'The creator page contains this film player.',
  evidence: 'A credited original product film.',
  techniques: ['Practical lighting'],
  whyItFits: 'Study the restrained opening.',
  usage: 'external_reference',
});

// A small DOM/event harness executes the actual standalone module. It does not
// open a browser, request external players, or substitute implementation logic.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this._text = '';
  }
  set textContent(value) {
    this._text = String(value);
    this.replaceChildren();
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  matches(selector) {
    const tag = selector.match(/^[a-z][a-z0-9]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const part of selector.matchAll(/\.([\w-]+)/g))
      if (!this.className.split(/\s+/).includes(part[1])) return false;
    if (selector.startsWith('#') && this.id !== selector.slice(1)) return false;
    for (const part of selector.matchAll(/\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]/g)) {
      const name = part[1];
      const value = name.startsWith('data-')
        ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
        : this.getAttribute(name);
      if (value === undefined || value === null || (part[2] !== undefined && value !== part[2]))
        return false;
    }
    return true;
  }
  closest(selector) {
    for (let item = this; item; item = item.parentElement) if (item.matches(selector)) return item;
    return null;
  }
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    const all = [];
    const walk = (parent) => {
      for (const child of parent.children) {
        if (child.matches(parts.at(-1))) {
          let parent = child.parentElement;
          let cursor = parts.length - 2;
          while (parent && cursor >= 0) {
            if (parent.matches(parts[cursor])) cursor--;
            parent = parent.parentElement;
          }
          if (cursor < 0) all.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return all;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get previousElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  async click() {
    const event = {
      type: 'click',
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    if (this.disabled) return event;
    for (let target = this; target; target = target.parentElement)
      for (const listener of target.listeners.get('click') ?? []) await listener(event);
    return event;
  }
}

async function room({
  embedded = true,
  stored = null,
  failLoad = false,
  films = [film('one'), film('two')],
  observe = false,
  reducedMotion = false,
} = {}) {
  const html = await readFile(new URL('../public/film-references.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/film-references.js', import.meta.url), 'utf8');
  const document = {
    elements: new Map(),
    createElement(tag) {
      return new Element(tag, this);
    },
    querySelector(selector) {
      if (selector.startsWith('#') && !selector.includes(' '))
        return this.elements.get(selector.slice(1)) ?? null;
      return [...this.elements.values()].find((element) => element.matches(selector)) ?? null;
    },
    querySelectorAll(selector) {
      return [...this.elements.values()].filter((element) => element.matches(selector));
    },
  };
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const element = document.createElement(match[1]);
    element.id = match[2];
    element.disabled = /\bdisabled(?:\s|>|=)/.test(match[0]);
    element.hidden = /\bhidden(?:\s|>|=)/.test(match[0]);
    document.elements.set(element.id, element);
  }
  const messages = [];
  const navigations = [];
  const copies = [];
  const downloads = [];
  const storage = new Map(stored === null ? [] : [['yap.film-reference-shortlist.v1', stored]]);
  const location = {
    origin: 'https://yap.example',
    href: 'https://yap.example/showcase/film-references.html',
    search: '',
    assign: (href) => navigations.push(href),
  };
  const window = {
    location,
    addEventListener() {},
    parent: null,
    matchMedia: () => ({ matches: reducedMotion, addEventListener() {} }),
  };
  const observers = [];
  class PreviewObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.targets = [];
    }
    show(target, visible) {
      this.callback([{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]);
    }
  }
  window.parent = embedded
    ? {
        location: { origin: location.origin },
        postMessage: (message, origin) => messages.push({ message, origin }),
      }
    : window;
  const catalog = { generatedAt: '2026-11-14T10:00:00.000Z', films };
  class DownloadURL extends URL {
    static createObjectURL(blob) {
      downloads.push(blob);
      return `blob:film-shortlist-${downloads.length}`;
    }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    ...core,
    ...(observe ? { IntersectionObserver: PreviewObserver } : {}),
    document,
    window,
    location,
    URL: DownloadURL,
    URLSearchParams,
    Blob,
    AbortController,
    navigator: { clipboard: { writeText: async (content) => copies.push(content) } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    fetch: async () => ({ ok: !failLoad, json: async () => catalog }),
    setTimeout,
    clearTimeout,
    console,
  });
  const script = source.replace(
    /^import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/film-references-core\.js['"];?\s*/,
    '',
  );
  new vm.Script(script, { filename: 'public/film-references.js' }).runInContext(context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    document,
    messages,
    navigations,
    copies,
    downloads,
    storage,
    catalog,
    $: (id) => document.elements.get(id),
    context,
    observers,
  };
}

test('films preview inline without title click-through and use sends only a catalog ID', async () => {
  const ui = await room({ films: [{ ...film('one'), watchUrl: 'https://vimeo.com/123456789' }] });
  const row = ui.$('fr-films').children[0];
  const title = row.querySelector('.fr-film-title');
  assert.equal(title.tagName, 'SPAN');
  assert.equal(row.querySelector('h3 a'), null);
  assert.equal(row.textContent.includes('Watch original'), false);
  const player = row.querySelector('iframe');
  assert.ok(player, 'The video player must be present without opening a preview toggle.');
  const src = new URL(player.src);
  assert.equal(src.origin, 'https://player.vimeo.com');
  assert.equal(src.searchParams.get('autoplay'), '1');
  assert.equal(src.searchParams.get('muted'), '1');
  assert.equal(src.searchParams.get('controls'), '1');
  assert.match(player.allow, /autoplay/);
  assert.equal(ui.messages.length, 0);
  const source = row.querySelector('.fr-source');
  assert.equal(source.href, ui.catalog.films[0].url);
  const use = row.querySelector('[data-reference-id]');
  assert.equal(new URL(use.href, ui.context.location.origin).hash, '#/create?reference=one');
  assert.equal((await use.click()).defaultPrevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.messages)), [
    { message: { type: 'yap:film-reference', filmId: 'one' }, origin: 'https://yap.example' },
  ]);
});

test('only visible film players mount and leaving the viewport releases them', async () => {
  const ui = await room({
    observe: true,
    films: [{ ...film('one'), watchUrl: 'https://vimeo.com/123456789' }],
  });
  const row = ui.$('fr-films').children[0];
  const holder = row.querySelector('.fr-film-preview');
  const observer = ui.observers[0];
  assert.equal(row.querySelector('iframe'), null, 'No offscreen provider request is started.');
  observer.show(holder, true);
  assert.ok(row.querySelector('iframe'));
  observer.show(holder, false);
  assert.equal(row.querySelector('iframe'), null, 'The player cannot keep running offscreen.');
});

test('reduced motion keeps an inline controlled player without automatic playback', async () => {
  const ui = await room({
    reducedMotion: true,
    films: [{ ...film('one'), watchUrl: 'https://vimeo.com/123456789' }],
  });
  const src = new URL(ui.$('fr-films').children[0].querySelector('iframe').src);
  assert.equal(src.searchParams.get('autoplay'), '0');
  assert.equal(src.searchParams.get('loop'), '0');
  assert.equal(src.searchParams.get('controls'), '1');
});

test('unsupported case pages stay in the library without arbitrary website iframes', async () => {
  const ui = await room({ films: [{ ...film('one'), watchUrl: 'https://creator.example/case' }] });
  const row = ui.$('fr-films').children[0];
  assert.equal(row.querySelector('iframe'), null);
  assert.match(row.textContent, /inline player is not available/);
  assert.ok(row.querySelector('[data-reference-id]'));
});

test('shortlist actions update saved state and pass selected catalog IDs without source payloads', async () => {
  const ui = await room();
  await ui.$('fr-films').children[0].querySelector('.fr-save').click();
  await ui.$('fr-films').children[1].querySelector('.fr-save').click();
  assert.equal(ui.$('fr-nav-count').textContent, '2');
  assert.deepEqual(JSON.parse(ui.storage.get('yap.film-reference-shortlist.v1')), ['one', 'two']);
  const use = ui.$('fr-use-shortlist');
  assert.ok(use, 'A saved shortlist needs a direct action into creation.');
  assert.equal(use.disabled, false);
  await use.click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))), {
    message: { type: 'yap:film-shortlist', filmIds: ['one', 'two'] },
    origin: 'https://yap.example',
  });
  await ui.$('fr-shortlist-items').children[0].querySelector('[data-remove-id]').click();
  assert.equal(ui.$('fr-nav-count').textContent, '1');
  assert.deepEqual(JSON.parse(ui.storage.get('yap.film-reference-shortlist.v1')), ['two']);
});

test('standalone use keeps a safe local creation link and does not pretend to copy footage', async () => {
  const ui = await room({ embedded: false });
  const use = ui.$('fr-films').children[0].querySelector('[data-reference-id]');
  assert.ok(use);
  assert.equal(use.href, '/#/create?reference=one');
  const clicked = await use.click();
  assert.equal(
    clicked.defaultPrevented,
    false,
    'Native same-origin navigation remains available outside the parent app.',
  );
  assert.deepEqual(ui.messages, []);
  assert.ok(!ui.$('fr-action-status').textContent.includes('footage copied'));
});

test('the bridge filters unknown IDs and fixed local routes encode catalog IDs as data', () => {
  const films = core.normalizeFilmCatalog({ films: [film('one'), film('two')] }).films;
  assert.equal(core.filmReferenceRequest(films, 'missing'), null);
  assert.equal(core.filmCreationHref(films, ['missing']), null);
  assert.deepEqual(core.filmReferenceRequest(films, ['two', 'missing', 'one', 'one']), {
    type: 'yap:film-shortlist',
    filmIds: ['one', 'two'],
  });
  assert.equal(
    core.filmCreationHref(films, ['two', 'one']),
    '/#/create?reference=one&reference=two',
  );
  const unusual = core.normalizeFilmCatalog({
    films: [film('one?next=https://evil.example/#x')],
  }).films;
  const href = core.filmCreationHref(unusual, unusual[0].id);
  const destination = new URL(href, 'https://yap.example');
  assert.equal(destination.origin, 'https://yap.example');
  assert.equal(destination.pathname, '/');
  assert.equal(destination.hash.split('?')[0], '#/create');
  assert.equal(new URLSearchParams(destination.hash.split('?')[1]).get('reference'), unusual[0].id);
});

test('load failure exposes a retry and keeps creation actions disabled', async () => {
  const ui = await room({ failLoad: true });
  assert.equal(ui.$('fr-films').children.length, 0);
  assert.equal(ui.$('fr-state').hidden, false);
  assert.equal(ui.$('fr-retry').hidden, false);
  assert.equal(ui.$('fr-use-shortlist').disabled, true);
  assert.match(ui.$('fr-state-copy').textContent, /could not be loaded/);
});

test('bridge requests and native links never silently truncate an oversized selection', () => {
  const films = Array.from({ length: 13 }, (_, index) => film(`film-${index}`));
  const ids = films.map((entry) => entry.id);
  assert.equal(core.FILM_REFERENCE_LIMIT, 12);
  assert.equal(core.filmReferenceRequest(films, ids), null);
  assert.equal(core.filmCreationHref(films, ids), null);
  assert.deepEqual(core.filmReferenceRequest(films, [...ids.slice(0, 12), ids[0]]), {
    type: 'yap:film-shortlist',
    filmIds: ids.slice(0, 12),
  });
});

for (const embedded of [true, false]) {
  test(`${embedded ? 'embedded' : 'standalone'} stored 13-film shortlist remains exportable and can be reduced before use`, async () => {
    const films = Array.from({ length: 13 }, (_, index) => film(`film-${index}`));
    const ids = films.map((entry) => entry.id);
    const ui = await room({ embedded, films, stored: JSON.stringify(ids) });
    const storedIds = () => JSON.parse(ui.storage.get('yap.film-reference-shortlist.v1'));
    const use = ui.$('fr-use-shortlist');
    assert.equal(ui.$('fr-nav-count').textContent, '13');
    assert.equal(ui.$('fr-shortlist-items').children.length, 13);
    assert.deepEqual(storedIds(), ids, 'Loading an older shortlist must preserve its entries.');
    assert.equal(use.disabled, true);
    assert.match(ui.$('fr-shortlist-summary').textContent, /up to 12.*Remove 1 film/);
    assert.equal(ui.$('fr-copy').disabled, false);
    assert.equal(ui.$('fr-download').disabled, false);
    await use.click();
    assert.deepEqual(ui.messages, []);
    assert.deepEqual(ui.navigations, []);
    assert.doesNotMatch(ui.$('fr-action-status').textContent, /Opening/);

    // The event handler also enforces the limit if disabled state is bypassed.
    use.disabled = false;
    await use.click();
    assert.deepEqual(ui.messages, []);
    assert.deepEqual(ui.navigations, []);
    assert.match(ui.$('fr-action-status').textContent, /up to 12.*Remove 1 film/);
    assert.doesNotMatch(ui.$('fr-action-status').textContent, /Opening/);

    await ui.$('fr-copy').click();
    await ui.$('fr-download').click();
    assert.deepEqual(
      JSON.parse(ui.copies[0]).films.map((entry) => entry.id),
      ids,
    );
    assert.deepEqual(
      JSON.parse(await ui.downloads[0].text()).films.map((entry) => entry.id),
      ids,
    );
    assert.deepEqual(storedIds(), ids, 'Exporting must not reduce the saved shortlist.');

    await ui.$('fr-shortlist-items').children[0].querySelector('[data-remove-id]').click();
    assert.equal(use.disabled, false);
    assert.equal(ui.$('fr-nav-count').textContent, '12');
    assert.deepEqual(storedIds(), ids.slice(1));
    await use.click();
    if (embedded) {
      assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))), {
        message: { type: 'yap:film-shortlist', filmIds: ids.slice(1) },
        origin: 'https://yap.example',
      });
      assert.deepEqual(ui.navigations, []);
    } else {
      assert.deepEqual(ui.messages, []);
      assert.equal(ui.navigations.length, 1);
      const destination = new URL(ui.navigations[0], ui.context.location.origin);
      assert.deepEqual(
        new URLSearchParams(destination.hash.split('?')[1]).getAll('reference'),
        ids.slice(1),
      );
    }
  });

  test(`${embedded ? 'embedded' : 'standalone'} adding a 13th film is refused without losing the first 12`, async () => {
    const films = Array.from({ length: 13 }, (_, index) => film(`film-${index}`));
    const ui = await room({ embedded, films });
    const rows = ui.$('fr-films').children;
    for (const row of rows.slice(0, 12)) await row.querySelector('.fr-save').click();
    await rows[12].querySelector('.fr-save').click();
    assert.equal(ui.$('fr-nav-count').textContent, '12');
    assert.equal(rows[12].querySelector('.fr-save').getAttribute('aria-pressed'), 'false');
    assert.match(ui.$('fr-action-status').textContent, /Remove a film.*maximum is 12/);
    assert.deepEqual(
      JSON.parse(ui.storage.get('yap.film-reference-shortlist.v1')),
      films.slice(0, 12).map((entry) => entry.id),
    );
    assert.deepEqual(ui.messages, []);
    assert.deepEqual(ui.navigations, []);

    await rows[0].querySelector('.fr-save').click();
    await rows[12].querySelector('.fr-save').click();
    assert.equal(ui.$('fr-nav-count').textContent, '12');
    assert.equal(rows[12].querySelector('.fr-save').getAttribute('aria-pressed'), 'true');
    await ui.$('fr-use-shortlist').click();
    assert.equal(embedded ? ui.messages.length : ui.navigations.length, 1);
  });
}
