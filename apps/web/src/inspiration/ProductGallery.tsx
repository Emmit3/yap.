import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookmarkSimple,
  Check,
  MagnifyingGlass,
  Pause,
  Play,
  X,
} from '@phosphor-icons/react';
import {
  filterProducts,
  loadProductInspiration,
  productCategories,
  type InspirationProduct,
  type ProductCategoryId,
} from './catalog';
import { FilmPreview } from './FilmPreview';
import { useVisibleClipPreviews } from './preview-playback';
import './gallery.css';

export interface ProductGalleryProps {
  onUseReferences(ids: string[]): void;
  active: boolean;
}
const MAX_SHORTLIST = 12;
const STORAGE_KEY = 'yap.film-reference-shortlist.v1';

export function ProductGallery({ onUseReferences, active }: ProductGalleryProps) {
  const [products, setProducts] = useState<InspirationProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ProductCategoryId>('all');
  const [shortlist, setShortlist] = useState<string[]>([]);
  const [onlySaved, setOnlySaved] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const restored = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const scrollPosition = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const discovery = useRef<HTMLDetailsElement>(null);
  const id = useId();
  const selected = products.find((product) => product.film.id === selectedId);
  const films = useMemo(
    () =>
      filterProducts(products, { query, category })
        .filter((product) => product.clip && (!onlySaved || shortlist.includes(product.film.id)))
        .sort((a, b) => Number(Boolean(b.clip?.poster)) - Number(Boolean(a.clip?.poster))),
    [products, query, category, onlySaved, shortlist],
  );
  const previewIds = useMemo(() => films.map((product) => product.film.id), [films]);
  const previews = useVisibleClipPreviews({
    ids: previewIds,
    active,
    suspended: Boolean(selected),
    paused,
    maxActive: 6,
  });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void loadProductInspiration(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setProducts(items);
        if (!restored.current) {
          restored.current = true;
          try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
              const parsed: unknown = JSON.parse(raw);
              if (!Array.isArray(parsed)) throw new Error('Invalid saved list');
              const known = new Set(items.map((product) => product.film.id));
              setShortlist([
                ...new Set(
                  parsed.filter(
                    (value): value is string => typeof value === 'string' && known.has(value),
                  ),
                ),
              ]);
            }
          } catch {
            setNotice('Saved films are unavailable in this browser.');
          }
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(cause instanceof Error ? cause.message : 'The films could not load.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (selected && active) {
      const frame = requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
      return () => cancelAnimationFrame(frame);
    }
  }, [selectedId, active]);
  useEffect(() => {
    const closeForNavigation = () => setSelectedId(null);
    window.addEventListener('hashchange', closeForNavigation);
    return () => window.removeEventListener('hashchange', closeForNavigation);
  }, []);

  function open(product: InspirationProduct) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scrollPosition.current = window.scrollY;
    discovery.current?.removeAttribute('open');
    setError('');
    setSelectedId(product.film.id);
    window.scrollTo({ top: 0 });
  }
  function close() {
    setSelectedId(null);
    setError('');
    requestAnimationFrame(() => {
      window.scrollTo({ top: scrollPosition.current });
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    });
  }
  function saveList(next: string[]) {
    setShortlist(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setNotice('');
    } catch {
      setNotice('Saved for this visit. Browser storage is unavailable.');
    }
  }
  function toggleSaved(product: InspirationProduct) {
    setError('');
    if (shortlist.includes(product.film.id))
      saveList(shortlist.filter((value) => value !== product.film.id));
    else if (shortlist.length >= MAX_SHORTLIST)
      setError('A video can use up to 12 references. Remove a saved film first.');
    else saveList([...shortlist, product.film.id]);
  }
  function useSelection(ids: string[]) {
    if (
      !ids.length ||
      ids.length > MAX_SHORTLIST ||
      ids.some((value) => !products.some((product) => product.film.id === value))
    ) {
      setError('Choose up to 12 films from this collection.');
      return;
    }
    setSelectedId(null);
    discovery.current?.removeAttribute('open');
    try {
      onUseReferences(ids);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The selection could not open.');
    }
  }

  return (
    <section
      className="product-gallery cinema"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (selected) {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (discovery.current?.open) {
            event.preventDefault();
            discovery.current.removeAttribute('open');
          }
        }
      }}
    >
      <h1 id={`${id}-title`} className="sr-only">
        Film inspiration
      </h1>
      <div className="cinema-tools">
        <details ref={discovery} className="cinema-discovery">
          <summary aria-label="Find a film">
            <MagnifyingGlass size={18} />
            <span className="sr-only">Find a film</span>
          </summary>
          <div className="cinema-discovery-panel">
            <label>
              <span className="sr-only">Search products, brands, and film techniques</span>
              <input
                type="search"
                value={query}
                placeholder="Search films"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="cinema-categories" role="group" aria-label="Film categories">
              {productCategories.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={category === item.id}
                  onClick={() => {
                    setCategory(item.id);
                    discovery.current?.removeAttribute('open');
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="cinema-discovery-actions">
              <button
                type="button"
                aria-pressed={onlySaved}
                onClick={() => setOnlySaved((value) => !value)}
              >
                <BookmarkSimple size={16} />
                Saved ({shortlist.length})
              </button>
              <button
                type="button"
                aria-pressed={paused || previews.reducedMotion}
                disabled={previews.reducedMotion}
                onClick={() => setPaused((value) => !value)}
              >
                {paused || previews.reducedMotion ? <Play size={16} /> : <Pause size={16} />}{' '}
                {paused || previews.reducedMotion ? 'Play previews' : 'Pause previews'}
              </button>
            </div>
            {shortlist.length > 0 && (
              <div className="cinema-saved-list">
                {shortlist.map((value) => {
                  const product = products.find((item) => item.film.id === value);
                  return product ? (
                    <div key={value}>
                      <button onClick={() => open(product)}>
                        {product.film.brand} · {product.film.product || product.film.title}
                      </button>
                      <button
                        aria-label={`Remove ${product.film.title} from shortlist`}
                        onClick={() => saveList(shortlist.filter((id) => id !== value))}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : null;
                })}
                <button
                  className="cinema-primary"
                  disabled={shortlist.length > MAX_SHORTLIST}
                  onClick={() => useSelection(shortlist)}
                >
                  Use saved films <ArrowRight size={16} />
                </button>
              </div>
            )}
            {(query || category !== 'all' || onlySaved) && (
              <button
                className="cinema-clear"
                onClick={() => {
                  setQuery('');
                  setCategory('all');
                  setOnlySaved(false);
                }}
              >
                Clear filters
              </button>
            )}
            {notice && <p role="status">{notice}</p>}
          </div>
        </details>
      </div>
      {error && (
        <p className="cinema-error" role="alert">
          {error}
        </p>
      )}
      {loadError ? (
        <div className="cinema-empty" role="alert">
          <p>The films couldn’t load.</p>
          <button onClick={() => setRevision((value) => value + 1)}>Try again</button>
        </div>
      ) : selected ? (
        <section className="cinema-detail" aria-labelledby={`${id}-detail-title`}>
          <button className="cinema-back" onClick={close}>
            <ArrowLeft size={18} />
            All videos
          </button>
          <div className="cinema-detail-layout">
            <div className="cinema-detail-player">
              {selected.clip?.poster && <img src={selected.clip.poster} alt="" />}
              {selected.clip && (
                <FilmPreview
                  clip={selected.clip}
                  active={active}
                  preview={false}
                  label={`${selected.film.brand}: ${selected.film.title}`}
                />
              )}
            </div>
            <div className="cinema-detail-copy">
              <p className="cinema-detail-brand">{selected.film.brand}</p>
              <h2 id={`${id}-detail-title`} ref={heading} tabIndex={-1}>
                {selected.film.product || selected.film.title}
              </h2>
              <p className="cinema-detail-title">
                {selected.film.title}
                {selected.film.year ? ` · ${selected.film.year}` : ''}
              </p>
              <p>{selected.film.whyItFits}</p>
              {selected.film.techniques.length > 0 && (
                <ul className="cinema-techniques">
                  {selected.film.techniques.slice(0, 4).map((technique) => (
                    <li key={technique}>{technique}</li>
                  ))}
                </ul>
              )}
              <div className="cinema-detail-actions">
                <button className="cinema-primary" onClick={() => useSelection([selected.film.id])}>
                  Make something like this <ArrowRight size={16} />
                </button>
                <button
                  className="cinema-save"
                  aria-pressed={shortlist.includes(selected.film.id)}
                  onClick={() => toggleSaved(selected)}
                >
                  {shortlist.includes(selected.film.id) ? (
                    <Check size={18} />
                  ) : (
                    <BookmarkSimple size={18} />
                  )}{' '}
                  {shortlist.includes(selected.film.id) ? 'Saved' : 'Save'}
                </button>
              </div>
              <a
                className="cinema-source"
                href={selected.clip?.sourceUrl || selected.film.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {selected.film.creator || 'Original source'} <ArrowUpRight size={14} />
              </a>
            </div>
          </div>
        </section>
      ) : loading ? (
        <div className="cinema-grid" aria-label="Loading films" aria-busy="true">
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} className="cinema-skeleton" />
          ))}
        </div>
      ) : films.length === 0 ? (
        <div className="cinema-empty">
          <p>No films found.</p>
          <button
            onClick={() => {
              setQuery('');
              setCategory('all');
              setOnlySaved(false);
            }}
          >
            Show all videos
          </button>
        </div>
      ) : (
        <div className="cinema-grid" aria-label="Product film collection">
          {films.map((product) => {
            const { film, clip } = product;
            if (!clip) return null;
            return (
              <article
                key={film.id}
                ref={previews.refFor(film.id)}
                className="cinema-film"
                data-film-id={film.id}
              >
                <div className="cinema-film-visual">
                  {clip.poster && (
                    <img
                      src={clip.poster}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                    />
                  )}
                  <FilmPreview
                    clip={clip}
                    active={previews.activeIds.has(film.id)}
                    label={`${film.brand}: ${film.title}`}
                  />
                </div>
                <button
                  className="cinema-film-open"
                  aria-label={`Open ${film.brand}: ${film.title}`}
                  onClick={() => open(product)}
                >
                  <span className="cinema-film-caption">
                    <strong>{film.brand}</strong>
                    <span>{film.product || film.title}</span>
                    <span className="cinema-film-description">{film.whyItFits}</span>
                  </span>
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
export default ProductGallery;
