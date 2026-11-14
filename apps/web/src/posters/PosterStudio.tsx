import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Check, MagnifyingGlass, Sparkle } from '@phosphor-icons/react';
import type { PosterDesign, PosterStyle } from '@yap/contracts/posters';
import { PosterCarousel } from './PosterCarousel';
import { posterApi } from './api';
import './posters.css';

const categories = [
  ['all', 'All styles'],
  ['party', 'Party'],
  ['music', 'Music'],
  ['popup', 'Pop ups'],
  ['craft', 'Arts and crafts'],
  ['market', 'Markets'],
];
const storageKey = 'yap.poster.last-design';
type Draft = { changes: string; saved?: PosterDesign };

function lastSavedDesign() {
  try {
    const value = sessionStorage.getItem(storageKey);
    return value && /^[a-f0-9-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function PosterWorkspace({
  onDirty,
  active = true,
}: {
  onDirty(value: boolean): void;
  active?: boolean;
}) {
  const [styles, setStyles] = useState<PosterStyle[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lastEditingId, setLastEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const editorImage = useRef<HTMLImageElement>(null);
  const sourceBounds = useRef<DOMRect | null>(null);
  const pointerAction = useRef(false);
  const restored = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void posterApi
      .styles(controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        setStyles(result.styles);
        const savedId = !restored.current ? lastSavedDesign() : null;
        restored.current = true;
        if (savedId) {
          try {
            const { design } = await posterApi.getDesign(savedId, controller.signal);
            if (controller.signal.aborted) return;
            const current = result.styles.find(
              (style) =>
                style.id === design.style.id && style.crop.sha256 === design.style.crop.sha256,
            );
            if (current) {
              setDrafts((previous) => ({
                ...previous,
                [current.id]: { changes: design.changes, saved: design },
              }));
              setLastEditingId(current.id);
            }
          } catch {
            /* A missing previous direction does not prevent choosing another style. */
          }
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error
              ? error.message
              : 'The styles could not be loaded. Please try again.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const navigation = () => {
      sourceBounds.current = null;
      setEditingId(null);
    };
    window.addEventListener('hashchange', navigation);
    return () => window.removeEventListener('hashchange', navigation);
  }, []);
  useEffect(() => {
    onDirty(
      Object.values(drafts).some((draft) => draft.changes.trim() !== (draft.saved?.changes ?? '')),
    );
  }, [drafts, onDirty]);
  useEffect(() => {
    if (editingId && active) editorHeading.current?.focus();
  }, [editingId, active]);
  useLayoutEffect(() => {
    if (!active) {
      sourceBounds.current = null;
      return;
    }
    if (!editingId) return;
    const image = editorImage.current;
    const source = sourceBounds.current;
    if (!image || !source || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const destination = image.getBoundingClientRect();
    if (!source.width || !destination.width) return;
    const x = source.x + source.width / 2 - destination.x - destination.width / 2;
    const y = source.y + source.height / 2 - destination.y - destination.height / 2;
    const animation = image.animate(
      [
        {
          transform: `translate(${x}px, ${y}px) scale(${source.width / destination.width}, ${source.height / destination.height})`,
        },
        { transform: 'none' },
      ],
      { duration: 360, easing: 'cubic-bezier(0.22,1,0.36,1)' },
    );
    return () => animation.cancel();
  }, [editingId, active]);

  const filtered = useMemo(
    () =>
      styles.filter(
        (style) =>
          (category === 'all' || style.category === category) &&
          `${style.title} ${style.category ?? ''}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [styles, category, query],
  );
  const editingStyle = styles.find((style) => style.id === editingId);
  const lastStyle = styles.find((style) => style.id === lastEditingId);
  const draft = editingStyle ? (drafts[editingStyle.id] ?? { changes: '' }) : { changes: '' };
  const currentSaved = Boolean(draft.saved && draft.saved.changes === draft.changes.trim());

  function open(style: PosterStyle) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sourceBounds.current = pointerAction.current
      ? (opener.current?.querySelector('img')?.getBoundingClientRect() ?? null)
      : null;
    setEditingId(style.id);
    setLastEditingId(style.id);
    setSaveError(null);
  }
  function back() {
    setEditingId(null);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
    });
  }
  function change(value: string) {
    if (!editingStyle) return;
    setDrafts((previous) => ({
      ...previous,
      [editingStyle.id]: { ...previous[editingStyle.id], changes: value },
    }));
    setSaveError(null);
  }
  function suggest(text: string) {
    change(`${draft.changes.trim()}${draft.changes.trim() ? '\n' : ''}${text}`.slice(0, 4000));
    field.current?.focus();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editingStyle || !draft.changes.trim() || savingId) return;
    const style = editingStyle,
      changes = draft.changes.trim();
    const controller = new AbortController();
    pending.current = controller;
    setSavingId(style.id);
    setSaveError(null);
    try {
      const { design } = await posterApi.createDesign(
        style.id,
        changes,
        style.crop.sha256,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDrafts((previous) => ({
        ...previous,
        [style.id]: { changes: previous[style.id]?.changes ?? changes, saved: design },
      }));
      try {
        sessionStorage.setItem(storageKey, design.id);
      } catch {
        /* The saved server record remains available without browser storage. */
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setSaveError({
          id: style.id,
          message:
            error instanceof Error
              ? error.message
              : 'Your changes could not be saved. Please try again.',
        });
    } finally {
      if (!controller.signal.aborted) setSavingId(null);
    }
  }

  return (
    <section
      className="poster-studio"
      aria-labelledby="poster-studio-title"
      onPointerDownCapture={() => {
        pointerAction.current = true;
      }}
      onKeyDownCapture={() => {
        pointerAction.current = false;
      }}
    >
      <div hidden={Boolean(editingStyle)}>
        <header className="poster-studio-heading">
          <div>
            <h1 id="poster-studio-title">Find your next poster.</h1>
            <p>Pick a look. Add your words, your details, your twist.</p>
          </div>
          {lastStyle && (
            <button className="poster-resume" onClick={() => open(lastStyle)}>
              <img src={posterApi.imageUrl(lastStyle.imageUrl)} alt="" />
              <span>
                Continue your design<strong>{lastStyle.title}</strong>
              </span>
              <ArrowUpRight size={18} />
            </button>
          )}
        </header>
        <div className="poster-studio-tools">
          <div className="poster-categories" role="group" aria-label="Poster categories">
            {categories.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                onClick={() => setCategory(value!)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="poster-style-search">
            <MagnifyingGlass size={18} />
            <input
              aria-label="Search poster styles"
              placeholder="Find a style"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        {loading ? (
          <div className="poster-studio-loading" role="status">
            <span>Finding your next look…</span>
            <div />
            <div />
            <div />
          </div>
        ) : loadError ? (
          <div className="poster-studio-empty" role="alert">
            <h2>The styles couldn’t load.</h2>
            <p>{loadError}</p>
            <button
              className="button button-secondary"
              onClick={() => setRevision((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : !styles.length ? (
          <div className="poster-studio-empty">
            <h2>A place for your next favorite design.</h2>
            <p>There are no poster styles in this workspace yet.</p>
          </div>
        ) : !filtered.length ? (
          <div className="poster-studio-empty">
            <h2>No styles found.</h2>
            <p>Try another category or a different search.</p>
            <button
              className="button button-secondary"
              onClick={() => {
                setQuery('');
                setCategory('all');
              }}
            >
              Show all styles
            </button>
          </div>
        ) : (
          <PosterCarousel styles={filtered} active={active && !editingStyle} onOpen={open} />
        )}
        {!loading && styles.length > 0 && (
          <div className="poster-studio-footnote">
            <p>Hover to take a closer look. Choose a poster to start.</p>
            <a href={styles[0]?.source.url} target="_blank" rel="noreferrer">
              Source collection <ArrowUpRight size={14} />
            </a>
          </div>
        )}
      </div>
      {editingStyle && (
        <section
          className="poster-customization"
          aria-labelledby="poster-editor-title"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            back();
          }}
        >
          <header className="poster-editor-heading">
            <button className="poster-back" onClick={back}>
              <ArrowLeft size={18} />
              All styles
            </button>
            <h1 id="poster-editor-title" ref={editorHeading} tabIndex={-1}>
              Make it yours.
            </h1>
            <span>{editingStyle.title}</span>
          </header>
          <div className="poster-workbench">
            <div className="poster-style-canvas">
              <img
                ref={editorImage}
                src={posterApi.imageUrl(editingStyle.imageUrl)}
                alt={`${editingStyle.title} style reference`}
                width={editingStyle.crop.width}
                height={editingStyle.crop.height}
              />
              <span className="poster-reference-label">Style reference</span>
            </div>
            <div className="poster-changes-panel">
              <div className="poster-changes-title">
                <Sparkle size={22} weight="light" />
                <h2 id="poster-changes-title">What would you like to add to this design?</h2>
              </div>
              <p>Your words. Your event. A different color or a whole new mood.</p>
              <form onSubmit={(event) => void save(event)}>
                <textarea
                  ref={field}
                  aria-labelledby="poster-changes-title"
                  required
                  maxLength={4000}
                  rows={7}
                  value={draft.changes}
                  placeholder="Add our event name and date. Swap the green for blue. Make it feel like a summer night."
                  onChange={(event) => change(event.target.value)}
                />
                <div className="poster-suggestions" aria-label="Ideas for your changes">
                  <button type="button" onClick={() => suggest('Use a softer color palette.')}>
                    Softer colors
                  </button>
                  <button
                    type="button"
                    onClick={() => suggest('Make the headline bolder and easier to read.')}
                  >
                    Bolder type
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      suggest('Leave a clear place for my event name, date, and venue.')
                    }
                  >
                    Add my event
                  </button>
                </div>
                <button
                  className="poster-save button button-primary"
                  type="submit"
                  disabled={!draft.changes.trim() || Boolean(savingId) || currentSaved}
                >
                  {savingId === editingStyle.id ? (
                    'Saving your direction…'
                  ) : currentSaved ? (
                    <>
                      <Check size={18} />
                      Direction saved
                    </>
                  ) : (
                    'Save my direction'
                  )}
                </button>
              </form>
              {saveError?.id === editingStyle.id && (
                <p className="poster-save-error" role="alert">
                  {saveError.message}
                </p>
              )}
              {currentSaved && (
                <div className="poster-saved" role="status">
                  <span>
                    <Check size={16} />
                    Your direction is saved.
                  </span>
                  <p>We’ll keep this style and your additions together.</p>
                </div>
              )}
              <p className="poster-style-note">
                The preview shows your selected style. Your changes are saved as the direction for
                your poster.
              </p>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
