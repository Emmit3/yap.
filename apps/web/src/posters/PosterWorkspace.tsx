import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Check, Copy, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { PosterContext, PosterReference } from '@yap/contracts/posters';
import { posterApi } from './api';
import './posters.css';

const categories = [
  ['all', 'All posters'],
  ['party', 'Party'],
  ['music', 'Music'],
  ['popup', 'Pop up'],
  ['craft', 'Arts and crafts'],
  ['market', 'Market'],
];

function categoryLabel(category = 'other') {
  return categories.find(([key]) => key === category)?.[1] ?? category;
}

function PosterStudy({ reference, onClose }: { reference: PosterReference; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!returnFocus.current && document.activeElement instanceof HTMLElement)
      returnFocus.current = document.activeElement;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="poster-study"
      onClose={onClose}
      aria-labelledby="poster-study-title"
    >
      <div className="poster-study-top">
        <h2 id="poster-study-title">{reference.title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close poster study">
          <X size={22} />
        </button>
      </div>
      <div className="poster-study-body">
        <div className="poster-study-image">
          <img src={posterApi.imageUrl(reference.imageUrl)} alt={reference.title} />
        </div>
        <div className="poster-study-notes">
          <h3>What makes it work</h3>
          <dl>
            <dt>Composition</dt>
            <dd>{reference.observed.layout}</dd>
            <dt>Typography</dt>
            <dd>{reference.observed.typography}</dd>
            <dt>Palette</dt>
            <dd>{reference.observed.palette.join(' · ')}</dd>
            <dt>Image treatment</dt>
            <dd>{reference.observed.imagery}</dd>
            <dt>Texture</dt>
            <dd>{reference.observed.texture}</dd>
          </dl>
          <h3>Design recipe</h3>
          <ol>
            {reference.reconstruction.instructions.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <p className="poster-fineprint">
            This recipe was written from the visible poster. It is not the designer’s original code
            or prompt. Small lettering in the source may be unreadable.
          </p>
          <a className="poster-source" href={reference.source.url} target="_blank" rel="noreferrer">
            Source reel at {reference.source.timestampSeconds}s <ArrowUpRight size={16} />
          </a>
        </div>
      </div>
    </dialog>
  );
}

export function PosterWorkspace({ onDirty }: { onDirty(value: boolean): void }) {
  const [references, setReferences] = useState<PosterReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<PosterReference | null>(null);
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState<PosterContext | null>(null);
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void posterApi
      .list(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setReferences(result.references);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error ? error.message : 'Poster references could not be loaded.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    onDirty(Boolean(prompt.trim() || selectedIds.length));
  }, [prompt, selectedIds, onDirty]);
  const selected = useMemo(
    () =>
      selectedIds.flatMap((id) => {
        const item = references.find((reference) => reference.id === id);
        return item ? [item] : [];
      }),
    [selectedIds, references],
  );
  const filtered = useMemo(
    () =>
      references.filter(
        (reference) =>
          (category === 'all' || reference.category === category) &&
          [
            reference.title,
            reference.observed.layout,
            reference.observed.typography,
            ...reference.observed.palette,
          ]
            .join(' ')
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [references, category, search],
  );

  function invalidate() {
    pending.current?.abort();
    setComposing(false);
    setContext(null);
    setComposeError('');
    setCopyStatus('');
  }
  function toggle(id: string) {
    invalidate();
    setSelectedIds((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id].slice(0, 3),
    );
  }
  async function compose(event: React.FormEvent) {
    event.preventDefault();
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setComposing(true);
    setComposeError('');
    setContext(null);
    setCopyStatus('');
    try {
      const result = await posterApi.context(prompt.trim(), selectedIds, controller.signal);
      if (!controller.signal.aborted) setContext(result);
    } catch (error) {
      if (!controller.signal.aborted)
        setComposeError(
          error instanceof Error
            ? error.message
            : 'The design prompt could not be prepared. Try again.',
        );
    } finally {
      if (!controller.signal.aborted) setComposing(false);
    }
  }
  async function copy() {
    if (!context) return;
    try {
      await navigator.clipboard.writeText(context.prompt);
      setCopyStatus('Prompt copied.');
    } catch {
      setCopyStatus('Copy is unavailable. Select the prompt below or download the brief.');
    }
  }
  function download() {
    if (!context) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(context, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'yap-poster-design-brief.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="poster-workspace" aria-labelledby="poster-page-title">
      <header className="poster-page-heading">
        <div>
          <h1 id="poster-page-title">A direction for your next poster.</h1>
          <p>
            Study the composition. Choose up to three references. Bring your own event, words, and
            images.
          </p>
        </div>
        {!loading && !loadError && (
          <span className="poster-library-count">{references.length} poster references</span>
        )}
      </header>
      <div className="poster-layout">
        <div className="poster-library">
          <div className="poster-controls">
            <label className="poster-search">
              <MagnifyingGlass size={20} aria-hidden="true" />
              <input
                aria-label="Search poster references"
                placeholder="Search layouts, type, or color"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="poster-category">
              <span>Category</span>
              <select
                aria-label="Poster category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {categories.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {loading ? (
            <div className="poster-loading" role="status">
              <span>Loading poster references…</span>
              <div />
              <div />
              <div />
            </div>
          ) : loadError ? (
            <div className="poster-empty" role="alert">
              <h2>References couldn’t load.</h2>
              <p>{loadError}</p>
              <button
                className="button button-secondary"
                onClick={() => setReload((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          ) : !references.length ? (
            <div className="poster-empty">
              <h2>Your reference library starts here.</h2>
              <p>
                No reviewed poster references are available in this workspace yet. Once a reference
                pack is installed, its posters and design recipes appear here.
              </p>
            </div>
          ) : !filtered.length ? (
            <div className="poster-empty">
              <h2>No matching posters.</h2>
              <p>Try another color, type style, or category.</p>
              <button
                className="button button-secondary"
                onClick={() => {
                  setSearch('');
                  setCategory('all');
                }}
              >
                Show all posters
              </button>
            </div>
          ) : (
            <div className="poster-grid">
              {filtered.map((reference) => {
                const chosen = selectedIds.includes(reference.id);
                return (
                  <article
                    className={`poster-option${chosen ? ' is-selected' : ''}`}
                    key={reference.id}
                  >
                    <button
                      className="poster-image-button"
                      onClick={() => setPreview(reference)}
                      aria-label={`Study ${reference.title}`}
                    >
                      <img
                        loading="lazy"
                        src={posterApi.imageUrl(reference.imageUrl)}
                        alt={reference.title}
                      />
                      {chosen && (
                        <span className="poster-chosen">
                          <Check size={16} weight="bold" />
                          <span className="sr-only">Selected</span>
                        </span>
                      )}
                    </button>
                    <div className="poster-option-info">
                      <span>{categoryLabel(reference.category)}</span>
                      <h2>{reference.title}</h2>
                      <div className="poster-option-actions">
                        <button className="text-button" onClick={() => setPreview(reference)}>
                          Study design
                        </button>
                        <button
                          className="poster-select"
                          aria-pressed={chosen}
                          disabled={!chosen && selectedIds.length === 3}
                          onClick={() => toggle(reference.id)}
                        >
                          {chosen ? 'Remove' : 'Use reference'}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {!loading && references.length > 0 && (
            <p className="poster-library-note">
              Poster crops retain the reel’s original resolution. The source reel curated these
              examples; individual design credits have not been established.{' '}
              <a href={references[0]?.source.url} target="_blank" rel="noreferrer">
                View source reel <ArrowUpRight size={14} />
              </a>
            </p>
          )}
        </div>
        <aside className="poster-composer" aria-labelledby="poster-composer-title">
          <div className="poster-composer-heading">
            <h2 id="poster-composer-title">Your design direction</h2>
            <span>{selectedIds.length}/3</span>
          </div>
          <p>Choose a main reference, then add details from another if needed.</p>
          <div className="poster-selection" aria-label="Selected poster references">
            {!selected.length ? (
              <p className="poster-selection-empty">Use a poster from the library to start.</p>
            ) : (
              selected.map((reference, i) => (
                <div className="poster-selected-item" key={reference.id}>
                  <img src={posterApi.imageUrl(reference.imageUrl)} alt="" />
                  <div>
                    <span>{i === 0 ? 'Main direction' : 'Supporting reference'}</span>
                    <strong>{reference.title}</strong>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${reference.title}`}
                    onClick={() => toggle(reference.id)}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))
            )}
          </div>
          <form onSubmit={(event) => void compose(event)}>
            <label htmlFor="poster-prompt">What is your poster for?</label>
            <textarea
              id="poster-prompt"
              rows={6}
              maxLength={4000}
              required
              value={prompt}
              placeholder="A late night jazz set at our café. Warm, intimate, and a little playful. Include the event name, date, venue, and booking details you want on the poster."
              onChange={(event) => {
                invalidate();
                setPrompt(event.target.value);
              }}
            />
            <p className="poster-fineprint">
              The selected recipes guide layout, typography, palette, and artwork. Your prompt
              supplies the event facts.
            </p>
            <button
              className="button button-primary poster-compose-button"
              type="submit"
              disabled={composing || !prompt.trim() || !selected.length}
            >
              {composing ? 'Preparing design prompt…' : 'Prepare design prompt'}
            </button>
          </form>
          {composeError && (
            <p className="poster-error" role="alert">
              {composeError}
            </p>
          )}
          {context && (
            <div className="poster-result" aria-live="polite">
              <h3>Your poster brief is ready.</h3>
              <p>
                Copy the prompt or download the brief with its reference links and recipes. This
                step prepares a design direction; it does not render a finished poster.
              </p>
              <div className="poster-export-actions">
                <button className="button button-secondary" onClick={() => void copy()}>
                  <Copy size={16} />
                  Copy prompt
                </button>
                <button className="text-button" onClick={download}>
                  <ArrowDown size={16} />
                  Download brief
                </button>
              </div>
              {copyStatus && <p role="status">{copyStatus}</p>}
              <details>
                <summary>Read the prepared prompt</summary>
                <pre>{context.prompt}</pre>
              </details>
            </div>
          )}
        </aside>
      </div>
      {preview && <PosterStudy reference={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}
