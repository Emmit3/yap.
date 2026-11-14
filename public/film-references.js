import {
  normalizeFilmCatalog,
  filterFilms,
  filmFilterOptions,
  readFilmShortlist,
  filmShortlistExport,
} from './film-references-core.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#fr-filters');
const search = $('#fr-search');
const category = $('#fr-category');
const creator = $('#fr-creator');
const featured = $('#fr-featured');
const list = $('#fr-films');
const shortlistItems = $('#fr-shortlist-items');
const storageKey = 'yap.film-reference-shortlist.v1';
let catalog = { films: [], scope: '', generatedAt: '', omitted: 0 };
let shortlisted = new Set();
let loadedOnce = false;
let request;
let requestVersion = 0;
let filterTimer;
let copying = false;

const node = (tag, className, value) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
};
function externalLink(label, url, className = '') {
  const link = node('a', className, label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}
function readableDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date)
    : '';
}
function announce(value) {
  $('#fr-action-status').textContent = value;
}
function saveButton(film) {
  const button = node('button', 'fr-text-button fr-save');
  button.type = 'button';
  button.dataset.filmId = film.id;
  updateSaveButton(button, film);
  return button;
}
function updateSaveButton(button, film) {
  const saved = shortlisted.has(film.id);
  button.textContent = saved ? 'Shortlisted ✓' : 'Save to shortlist +';
  button.setAttribute('aria-pressed', String(saved));
  button.setAttribute(
    'aria-label',
    `${saved ? 'Remove' : 'Add'} ${film.title} ${saved ? 'from' : 'to'} your shortlist`,
  );
}
function filmRow(film, index) {
  const item = node('li', 'fr-film');
  const number = node('span', 'fr-index', String(index + 1).padStart(3, '0'));
  number.setAttribute('aria-hidden', 'true');
  const body = node('article', 'fr-film-body');
  const meta = node('div', 'fr-film-meta');
  meta.append(node('span', '', film.brand), node('span', '', film.category));
  if (film.year) meta.append(node('span', '', String(film.year)));
  if (film.kind === 'spec') meta.append(node('span', '', 'Spec film'));
  if (film.featured) meta.append(node('span', 'fr-featured', '↗ Highlight'));
  body.append(meta, node('h3', '', film.title), node('p', 'fr-creator', `By ${film.creator}`));
  if (film.product) body.append(node('p', 'fr-creator', film.product));
  body.append(
    node(
      'p',
      'fr-film-note',
      film.whyItFits || 'Explore the original film and its production notes.',
    ),
  );
  const proof = node('details', 'fr-proof');
  proof.append(node('summary', '', 'Source notes'));
  if (film.evidence) proof.append(node('p', '', film.evidence));
  if (film.techniques.length)
    proof.append(node('p', '', `Production techniques: ${film.techniques.join(' · ')}`));
  const checked = readableDate(film.verifiedAt);
  if (checked) proof.append(node('p', '', `Film and player sources checked ${checked}.`));
  proof.append(externalLink('Read the creator’s case study ↗', film.url));
  body.append(proof);
  const actions = node('div', 'fr-film-actions');
  const watch = externalLink('Watch film ↗', film.watchUrl, 'fr-button');
  watch.setAttribute('aria-label', `Watch ${film.title} on the original site, opens a new tab`);
  const source = externalLink('Case study ↗', film.url, 'fr-button fr-button-secondary');
  source.setAttribute('aria-label', `Read the case study for ${film.title}, opens a new tab`);
  actions.append(watch, source, saveButton(film));
  item.append(number, body, actions);
  return item;
}
function showState(title, copy, { retry = false, reset = false } = {}) {
  $('#fr-state-title').textContent = title;
  $('#fr-state-copy').textContent = copy;
  $('#fr-retry').hidden = !retry;
  $('#fr-empty-reset').hidden = !reset;
  $('#fr-state').hidden = false;
}
function renderResults() {
  clearTimeout(filterTimer);
  const filters = {
    query: search.value,
    category: category.value,
    creator: creator.value,
    featuredOnly: featured.checked,
  };
  const results = filterFilms(catalog.films, filters);
  list.replaceChildren(...results.map(filmRow));
  $('#fr-state').hidden = true;
  $('#fr-result-count').textContent = `Showing ${results.length} of ${catalog.films.length} films`;
  if (!results.length) {
    if (catalog.films.length)
      showState(
        'No films match yet.',
        'Try a different brand or technique, or clear the filters to see the whole collection.',
        { reset: true },
      );
    else
      showState(
        'The collection is empty.',
        'The source list has no films available. Try loading it again.',
        { retry: true },
      );
  }
}
function populateOptions(select, field, label) {
  const previous = select.value;
  const all = node('option', '', label);
  all.value = '';
  const options = filmFilterOptions(catalog.films, field).map(({ value, count }) => {
    const option = node('option', '', `${value} (${count})`);
    option.value = value;
    return option;
  });
  select.replaceChildren(all, ...options);
  select.value = options.some((option) => option.value === previous) ? previous : '';
}
function renderShortlist() {
  const films = catalog.films.filter((film) => shortlisted.has(film.id));
  $('#fr-nav-count').textContent = String(films.length);
  $('#fr-shortlist-summary').textContent = films.length
    ? `${films.length} ${films.length === 1 ? 'film' : 'films'} saved. Copy or download the original sources.`
    : 'Save films as you browse, then take the sources with you.';
  shortlistItems.replaceChildren(
    ...films.map((film) => {
      const item = node('li');
      item.dataset.filmId = film.id;
      const remove = node('button', 'fr-text-button', 'Remove');
      remove.type = 'button';
      remove.dataset.removeId = film.id;
      remove.setAttribute('aria-label', `Remove ${film.title} from your shortlist`);
      item.append(externalLink(film.title, film.watchUrl), remove);
      return item;
    }),
  );
  for (const id of ['#fr-copy', '#fr-download', '#fr-clear-shortlist'])
    $(id).disabled = !films.length || (id === '#fr-copy' && copying);
}
function persistShortlist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...shortlisted]));
    return true;
  } catch {
    return false;
  }
}
function toggleShortlist(id) {
  const film = catalog.films.find((entry) => entry.id === id);
  if (!film) return;
  if (shortlisted.has(id)) shortlisted.delete(id);
  else shortlisted.add(id);
  const persisted = persistShortlist();
  list.querySelectorAll('.fr-save').forEach((button) => {
    if (button.dataset.filmId === id) updateSaveButton(button, film);
  });
  renderShortlist();
  announce(
    persisted
      ? `${film.title} ${shortlisted.has(id) ? 'added to' : 'removed from'} your shortlist.`
      : 'Shortlist updated for this visit. Download it to keep a copy.',
  );
}
async function loadCatalog() {
  request?.abort();
  const current = ++requestVersion;
  const controller = new AbortController();
  request = controller;
  const timer = setTimeout(() => controller.abort(), 20_000);
  $('#fr-state').hidden = true;
  $('#fr-loading').hidden = false;
  $('#fr-filter-fields').disabled = true;
  list.hidden = true;
  list.setAttribute('aria-busy', 'true');
  $('#fr-result-count').textContent = 'Loading film references…';
  try {
    const response = await fetch('./film-references.json', {
      signal: controller.signal,
      cache: 'no-cache',
    });
    if (!response.ok) throw new Error('The film list could not be loaded. Please try again.');
    const next = normalizeFilmCatalog(await response.json());
    if (current !== requestVersion || controller.signal.aborted) return;
    catalog = next;
    if (!loadedOnce) {
      let stored = null;
      try {
        stored = localStorage.getItem(storageKey);
      } catch {
        /* The shortlist still works for this visit. */
      }
      shortlisted = readFilmShortlist(stored, catalog.films);
    } else
      shortlisted = new Set(
        [...shortlisted].filter((id) => catalog.films.some((film) => film.id === id)),
      );
    loadedOnce = true;
    $('#fr-total').textContent = String(catalog.films.length);
    populateOptions(category, 'category', 'All categories');
    populateOptions(creator, 'creator', 'All creators');
    $('#fr-data-note').hidden = !catalog.omitted;
    $('#fr-data-note').textContent =
      `${catalog.omitted} source ${catalog.omitted === 1 ? 'record was' : 'records were'} unavailable and omitted from this view.`;
    const checked = readableDate(catalog.generatedAt);
    $('#fr-checked-date').textContent = checked
      ? `Collection updated ${checked}.`
      : 'A collection for studying the craft.';
    $('#fr-filter-fields').disabled = false;
    list.hidden = false;
    renderResults();
    renderShortlist();
  } catch (error) {
    if (current !== requestVersion) return;
    $('#fr-result-count').textContent = 'The collection could not be loaded.';
    showState(
      'The films are taking a moment.',
      controller.signal.aborted
        ? 'The request took too long. Try loading the collection again.'
        : error instanceof SyntaxError
          ? 'The film list could not be read. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Please try loading the collection again.',
      { retry: true },
    );
  } finally {
    clearTimeout(timer);
    if (current === requestVersion) {
      $('#fr-loading').hidden = true;
      list.setAttribute('aria-busy', 'false');
      request = null;
    }
  }
}
function clearFilters() {
  search.value = '';
  category.value = '';
  creator.value = '';
  featured.checked = false;
  renderResults();
  search.focus();
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  renderResults();
});
form.addEventListener('reset', (event) => {
  event.preventDefault();
  clearFilters();
});
search.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderResults, 120);
});
for (const control of [category, creator, featured])
  control.addEventListener('change', renderResults);
$('#fr-empty-reset').addEventListener('click', clearFilters);
$('#fr-retry').addEventListener('click', loadCatalog);
list.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-film-id]');
  if (button) toggleShortlist(button.dataset.filmId);
});
shortlistItems.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-remove-id]');
  if (!button) return;
  const item = button.closest('li');
  const nextId = (item.nextElementSibling ?? item.previousElementSibling)?.dataset.filmId;
  toggleShortlist(button.dataset.removeId);
  const next = [...shortlistItems.querySelectorAll('button')].find(
    (entry) => entry.dataset.removeId === nextId,
  );
  (next ?? $('#fr-shortlist-title')).focus();
});
$('#fr-clear-shortlist').addEventListener('click', () => {
  shortlisted.clear();
  const persisted = persistShortlist();
  list.querySelectorAll('.fr-save').forEach((button) => {
    const film = catalog.films.find((entry) => entry.id === button.dataset.filmId);
    if (film) updateSaveButton(button, film);
  });
  renderShortlist();
  announce(
    persisted
      ? 'Shortlist cleared.'
      : 'Shortlist cleared for this visit. Browser storage is unavailable.',
  );
  $('#fr-shortlist-title').focus();
});
$('#fr-copy').addEventListener('click', async () => {
  if (copying || !shortlisted.size) return;
  copying = true;
  const button = $('#fr-copy');
  const payload = JSON.stringify(filmShortlistExport(catalog.films, shortlisted), null, 2);
  button.disabled = true;
  button.textContent = 'Copying…';
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(payload);
    announce('Shortlist copied with film IDs and original source links.');
  } catch {
    announce('Clipboard access is unavailable. Download the shortlist instead.');
  } finally {
    copying = false;
    button.textContent = 'Copy shortlist';
    button.disabled = !shortlisted.size;
  }
});
$('#fr-download').addEventListener('click', () => {
  const payload = JSON.stringify(filmShortlistExport(catalog.films, shortlisted), null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const link = node('a');
  link.href = url;
  link.download = 'yap-film-shortlist.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce('Shortlist download started with film IDs and original source links.');
});
if (window.parent !== window) {
  document.querySelectorAll('[data-yap-home]').forEach((link) => {
    link.href = './index.html?embedded=1';
  });
}
window.addEventListener('pagehide', () => {
  requestVersion += 1;
  request?.abort();
  clearTimeout(filterTimer);
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void loadCatalog();
});
void loadCatalog();
