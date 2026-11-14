import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookmarkSimple,
  Check,
  FilmSlate,
  MagnifyingGlass,
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
import './gallery.css';

export interface ProductGalleryProps {
  onUseReferences(ids: string[]): void;
  /** The parent keeps this room mounted. Hidden rooms never retain a media player. */
  active: boolean;
}

const MAX_SHORTLIST = 12;
const SHORTLIST_STORAGE_KEY = 'yap.film-reference-shortlist.v1';

function motionBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/** Mouse dragging supplements native touch scrolling, buttons, and keyboard navigation. */
function usePanScroll(refreshKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointer: number; x: number; y: number; scroll: number; moved: boolean }>(
    null,
  );
  const suppressClick = useRef(false);
  const resetClick = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragging, setDragging] = useState(false);
  const [edges, setEdges] = useState({ start: true, end: true });

  function updateEdges() {
    const node = ref.current;
    if (!node) return;
    const next = {
      start: node.scrollLeft <= 2,
      end: node.scrollLeft + node.clientWidth >= node.scrollWidth - 2,
    };
    setEdges((previous) =>
      previous.start === next.start && previous.end === next.end ? previous : next,
    );
  }

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    updateEdges();
    const resize = new ResizeObserver(updateEdges);
    resize.observe(node);
    return () => resize.disconnect();
  }, [refreshKey]);
  useEffect(
    () => () => {
      if (resetClick.current) clearTimeout(resetClick.current);
    },
    [],
  );

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (current.moved) {
      suppressClick.current = true;
      if (resetClick.current) clearTimeout(resetClick.current);
      resetClick.current = setTimeout(() => {
        suppressClick.current = false;
        resetClick.current = null;
      }, 0);
    }
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return {
    ref,
    edges,
    move(direction: -1 | 1) {
      const node = ref.current;
      if (node)
        node.scrollBy({ left: direction * node.clientWidth * 0.85, behavior: motionBehavior() });
    },
    handlers: {
      'data-dragging': dragging || undefined,
      onScroll: updateEdges,
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest('button, a, input, textarea, select, video, iframe, summary')
        )
          return;
        gesture.current = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          scroll: event.currentTarget.scrollLeft,
          moved: false,
        };
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const current = gesture.current;
        if (!current || current.pointer !== event.pointerId) return;
        if (event.buttons === 0) {
          endDrag(event);
          return;
        }
        const delta = event.clientX - current.x;
        if (!current.moved) {
          if (Math.abs(delta) < 6 || Math.abs(delta) <= Math.abs(event.clientY - current.y)) return;
          current.moved = true;
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.currentTarget.scrollLeft = current.scroll - delta;
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onPointerLeave(event: PointerEvent<HTMLDivElement>) {
        if (gesture.current && !gesture.current.moved) endDrag(event);
      },
      onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
        if (gesture.current?.pointer === event.pointerId) {
          gesture.current = null;
          setDragging(false);
        }
      },
      onClickCapture(event: MouseEvent<HTMLDivElement>) {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.target !== event.currentTarget) return;
        const node = event.currentTarget;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          node.scrollBy({
            left: (event.key === 'ArrowLeft' ? -1 : 1) * node.clientWidth * 0.85,
            behavior: motionBehavior(),
          });
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          node.scrollTo({
            left: event.key === 'Home' ? 0 : node.scrollWidth,
            behavior: motionBehavior(),
          });
        }
      },
    },
  };
}

export function ProductGallery({ onUseReferences, active }: ProductGalleryProps) {
  const [products, setProducts] = useState<InspirationProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ProductCategoryId>('all');
  const [shortlist, setShortlist] = useState<string[]>([]);
  const shortlistInitialized = useRef(false);
  const [storageNotice, setStorageNotice] = useState('');
  const [onlyShortlist, setOnlyShortlist] = useState(false);
  const [playingId, setPlayingId] = useState('');
  const [failedPlayer, setFailedPlayer] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [status, setStatus] = useState('');
  const galleryId = useId();
  const listId = `${galleryId}-films`;
  const helpId = `${galleryId}-browse-help`;
  const visibleProducts = useMemo(() => {
    const filtered = filterProducts(products, { query, category });
    return onlyShortlist
      ? filtered.filter((product) => shortlist.includes(product.film.id))
      : filtered;
  }, [products, query, category, onlyShortlist, shortlist]);
  const rail = usePanScroll(`${active}-${loading}-${visibleProducts.length}`);
  const categories = usePanScroll(String(active));
  const categoryCounts = useMemo(() => {
    const counts = new Map<ProductCategoryId, number>();
    counts.set('all', products.length);
    for (const product of products)
      counts.set(product.category, (counts.get(product.category) ?? 0) + 1);
    return counts;
  }, [products]);
  const selectedProducts = useMemo(
    () => shortlist.map((id) => products.find((product) => product.film.id === id)).filter(Boolean),
    [products, shortlist],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void loadProductInspiration(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setProducts(items);
        const knownIds = new Set(items.map((product) => product.film.id));
        if (!shortlistInitialized.current) {
          let restored: string[] = [];
          let stored: string | null = null;
          try {
            stored = window.localStorage.getItem(SHORTLIST_STORAGE_KEY);
          } catch {
            setStorageNotice(
              'Browser storage is unavailable. Shortlist changes will stay here for this visit.',
            );
          }
          if (stored !== null) {
            try {
              const value: unknown = JSON.parse(stored);
              if (!Array.isArray(value)) throw new Error('Unreadable shortlist');
              restored = [
                ...new Set(
                  value.filter((id): id is string => typeof id === 'string' && knownIds.has(id)),
                ),
              ];
            } catch {
              setStorageNotice(
                'Your saved shortlist could not be read. Saving a new selection will replace it.',
              );
            }
          }
          // Restoration never writes. In particular, the initial empty state must not erase
          // an older shortlist, and legacy lists over the creation limit remain intact.
          shortlistInitialized.current = true;
          setShortlist(restored);
        } else {
          setShortlist((previous) => previous.filter((id) => knownIds.has(id)));
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(
            caught instanceof Error ? caught.message : 'The product films could not be loaded.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!active || (playingId && !visibleProducts.some((item) => item.film.id === playingId))) {
      setPlayingId('');
      setFailedPlayer('');
    }
  }, [active, playingId, visibleProducts]);
  useEffect(() => {
    if (!active || !playingId) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(`${galleryId}-player-${playingId}`)?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [active, playingId, galleryId]);

  function resetBrowse() {
    setQuery('');
    setCategory('all');
    setOnlyShortlist(false);
    rail.ref.current?.scrollTo({ left: 0 });
  }
  function saveShortlist(next: string[]) {
    if (!shortlistInitialized.current) return;
    setShortlist(next);
    try {
      window.localStorage.setItem(SHORTLIST_STORAGE_KEY, JSON.stringify(next));
      setStorageNotice('');
    } catch {
      setStorageNotice(
        'Browser storage is unavailable. Shortlist changes will stay here for this visit.',
      );
    }
  }
  function toggleSaved(product: InspirationProduct) {
    const id = product.film.id;
    setSelectionError('');
    if (shortlist.includes(id)) {
      saveShortlist(shortlist.filter((saved) => saved !== id));
      setStatus(`${product.film.brand || product.film.title} removed from your shortlist.`);
    } else if (shortlist.length >= MAX_SHORTLIST) {
      setSelectionError(
        `Your shortlist has ${shortlist.length} films. Remove films before adding more. A creation can use up to ${MAX_SHORTLIST}.`,
      );
    } else {
      saveShortlist([...shortlist, id]);
      setStatus(`${product.film.brand || product.film.title} saved to your shortlist.`);
    }
  }
  function useSelection(ids: string[]) {
    setSelectionError('');
    if (ids.length === 0 || ids.length > MAX_SHORTLIST) {
      setSelectionError(
        ids.length > MAX_SHORTLIST
          ? `Remove ${ids.length - MAX_SHORTLIST} ${ids.length - MAX_SHORTLIST === 1 ? 'film' : 'films'} from this shortlist before using it. A creation can use up to ${MAX_SHORTLIST}.`
          : 'Choose at least one film to use for your video.',
      );
      return;
    }
    if (ids.some((id) => !products.some((product) => product.film.id === id))) {
      setSelectionError(
        'Some selected films are no longer in this collection. Reload and choose them again.',
      );
      return;
    }
    try {
      onUseReferences(ids);
    } catch (caught: unknown) {
      setSelectionError(
        caught instanceof Error ? caught.message : 'The selected films could not be opened.',
      );
    }
  }
  function closePlayer(id: string) {
    setPlayingId('');
    setFailedPlayer('');
    requestAnimationFrame(() => document.getElementById(`${galleryId}-play-${id}`)?.focus());
  }

  return (
    <section className="product-gallery" aria-labelledby={`${galleryId}-heading`}>
      <header className="product-gallery-heading">
        <div>
          <h1 id={`${galleryId}-heading`}>A little inspiration. Your own next video.</h1>
          <p>
            Explore real product films. Save the ideas and techniques you want to make your own.
          </p>
        </div>
        <label className="product-gallery-search">
          <span className="sr-only">Search products, brands, and film techniques</span>
          <MagnifyingGlass size={20} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Try Adidas, coffee, or stop motion"
            onChange={(event) => {
              setQuery(event.target.value);
              rail.ref.current?.scrollTo({ left: 0 });
            }}
          />
        </label>
      </header>

      <div
        ref={categories.ref}
        className="product-gallery-categories"
        role="group"
        aria-label="Filter by product category"
        {...categories.handlers}
      >
        {productCategories
          .filter((item) => loading || item.id === 'all' || categoryCounts.has(item.id))
          .map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={category === item.id}
              aria-controls={listId}
              onClick={() => {
                setCategory(item.id);
                rail.ref.current?.scrollTo({ left: 0 });
              }}
            >
              {item.label}
              {!loading && (
                <span className="product-gallery-category-count">
                  {categoryCounts.get(item.id) ?? 0}
                </span>
              )}
            </button>
          ))}
      </div>

      <div className="product-gallery-browse-bar">
        <div className="product-gallery-result-summary">
          <p role="status">
            {loading
              ? 'Opening the film collection…'
              : `${visibleProducts.length} ${visibleProducts.length === 1 ? 'film' : 'films'}${onlyShortlist ? ' in your shortlist' : ' to explore'}`}
          </p>
          <button
            className="product-gallery-saved-filter"
            type="button"
            aria-pressed={onlyShortlist}
            aria-controls={listId}
            onClick={() => {
              setOnlyShortlist((previous) => !previous);
              rail.ref.current?.scrollTo({ left: 0 });
            }}
          >
            <BookmarkSimple
              size={16}
              weight={onlyShortlist ? 'fill' : 'regular'}
              aria-hidden="true"
            />
            Saved ({shortlist.length})
          </button>
        </div>
        <div className="product-gallery-scroll-actions">
          <span id={helpId}>Swipe or drag to explore</span>
          <button
            type="button"
            aria-label="Previous product films"
            aria-controls={listId}
            disabled={loading || rail.edges.start}
            onClick={() => rail.move(-1)}
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Next product films"
            aria-controls={listId}
            disabled={loading || rail.edges.end}
            onClick={() => rail.move(1)}
          >
            <ArrowRight size={20} aria-hidden="true" />
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="product-gallery-empty" role="alert">
          <h2>The collection could not open.</h2>
          <p>{loadError}</p>
          <button
            type="button"
            className="product-gallery-primary"
            onClick={() => setReload((n) => n + 1)}
          >
            Try loading again
          </button>
        </div>
      ) : !loading && visibleProducts.length === 0 ? (
        <div className="product-gallery-empty">
          <FilmSlate size={32} aria-hidden="true" />
          <h2>
            {onlyShortlist && shortlist.length === 0
              ? 'Keep the films that catch your eye.'
              : 'Try another product or style.'}
          </h2>
          <p>
            {onlyShortlist && shortlist.length === 0
              ? 'Save a film to build a shortlist, then bring its cited techniques into your video.'
              : 'Search a brand, product, or technique, or explore the full collection.'}
          </p>
          <button type="button" className="product-gallery-primary" onClick={resetBrowse}>
            Explore all films
          </button>
        </div>
      ) : (
        <div
          ref={rail.ref}
          id={listId}
          className={`product-gallery-rail${loading ? ' product-gallery-loading' : ''}`}
          role="region"
          aria-label="Product film collection"
          aria-describedby={helpId}
          aria-busy={loading}
          tabIndex={0}
          {...rail.handlers}
        >
          {loading
            ? [0, 1, 2].map((item) => (
                <div className="product-gallery-skeleton" key={item} aria-hidden="true">
                  <div />
                  <span />
                  <span />
                </div>
              ))
            : visibleProducts.map((product) => {
                const { film, clip } = product;
                const saved = shortlist.includes(film.id);
                const playing = active && playingId === film.id;
                const categoryLabel = productCategories.find(
                  (item) => item.id === product.category,
                )?.label;
                return (
                  <article
                    className="product-film"
                    key={film.id}
                    aria-label={`${film.brand}: ${film.title}`}
                  >
                    <div className={`product-film-media${playing ? ' is-playing' : ''}`}>
                      {playing && clip ? (
                        <div
                          id={`${galleryId}-player-${film.id}`}
                          className="product-film-player"
                          tabIndex={-1}
                          role="group"
                          aria-label={`${film.brand} original film player`}
                        >
                          {failedPlayer === film.id ? (
                            <div className="product-film-player-error" role="alert">
                              <p>This clip could not play here.</p>
                              <a href={clip.sourceUrl} target="_blank" rel="noopener noreferrer">
                                Watch the original <ArrowUpRight size={16} aria-hidden="true" />
                              </a>
                            </div>
                          ) : clip.kind === 'video' ? (
                            <video
                              src={clip.src}
                              poster={clip.poster}
                              controls
                              autoPlay
                              muted
                              playsInline
                              preload="none"
                              aria-label={`${film.brand}: ${film.title}`}
                              onError={() => setFailedPlayer(film.id)}
                            />
                          ) : (
                            <iframe
                              src={clip.src}
                              title={`${film.brand}: ${film.title} on ${clip.provider}`}
                              allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                              allowFullScreen
                              referrerPolicy="strict-origin-when-cross-origin"
                            />
                          )}
                          <button
                            type="button"
                            className="product-film-close"
                            aria-label={`Close ${film.brand} film player`}
                            onClick={() => closePlayer(film.id)}
                          >
                            <X size={18} aria-hidden="true" />
                          </button>
                        </div>
                      ) : (
                        <>
                          {clip?.poster ? (
                            <img src={clip.poster} alt="" loading="lazy" draggable={false} />
                          ) : (
                            <div className="product-film-title-cover" aria-hidden="true">
                              <FilmSlate size={28} />
                              <strong>{film.brand}</strong>
                              <span>{film.product || 'Product film'}</span>
                            </div>
                          )}
                          {clip ? (
                            <button
                              id={`${galleryId}-play-${film.id}`}
                              type="button"
                              className="product-film-play"
                              onClick={() => {
                                setFailedPlayer('');
                                setPlayingId(film.id);
                              }}
                              aria-label={`Play ${film.brand}: ${film.title}`}
                            >
                              <Play size={20} weight="fill" aria-hidden="true" />
                              Play original
                            </button>
                          ) : (
                            <a
                              className="product-film-play"
                              href={film.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Watch original <ArrowUpRight size={18} aria-hidden="true" />
                            </a>
                          )}
                        </>
                      )}
                    </div>
                    <div className="product-film-content">
                      <div className="product-film-labels">
                        <span>{categoryLabel}</span>
                        <span>
                          {film.kind === 'spec'
                            ? 'Independent spec'
                            : film.kind === 'campaign'
                              ? 'Campaign'
                              : 'Film study'}
                        </span>
                      </div>
                      <h2>{film.brand}</h2>
                      <p className="product-film-product">{film.product || film.title}</p>
                      <p className="product-film-title">
                        {film.title}
                        {film.year ? ` · ${film.year}` : ''}
                      </p>
                      {film.techniques.length > 0 && (
                        <ul className="product-film-techniques" aria-label="Creative techniques">
                          {film.techniques.slice(0, 3).map((technique) => (
                            <li key={technique}>{technique}</li>
                          ))}
                        </ul>
                      )}
                      <details className="product-film-notes">
                        <summary>What to take from it</summary>
                        <p>{film.whyItFits}</p>
                        {film.creator && <p>Film by {film.creator}</p>}
                        <p>
                          Editorial notes describe creative techniques. The film stays with its
                          original creator.
                        </p>
                      </details>
                      <div className="product-film-actions">
                        <button
                          type="button"
                          className="product-gallery-primary"
                          onClick={() => useSelection([film.id])}
                        >
                          Use for my video <ArrowRight size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="product-film-save"
                          aria-label={`${saved ? 'Remove' : 'Save'} ${film.brand}: ${film.title}${saved ? ' from' : ' to'} shortlist`}
                          aria-pressed={saved}
                          onClick={() => toggleSaved(product)}
                        >
                          {saved ? (
                            <Check size={20} aria-hidden="true" />
                          ) : (
                            <BookmarkSimple size={20} aria-hidden="true" />
                          )}
                        </button>
                      </div>
                      <a
                        className="product-film-source"
                        href={clip?.sourceUrl || film.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {clip ? `Original on ${clip.provider}` : 'Open original source'}
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </a>
                    </div>
                  </article>
                );
              })}
        </div>
      )}

      {storageNotice && (
        <p className="product-gallery-storage-notice" role="status">
          {storageNotice}
        </p>
      )}
      {selectionError && (
        <p className="product-gallery-error" role="alert">
          {selectionError}
        </p>
      )}
      <p className="sr-only" role="status">
        {status}
      </p>
      {shortlist.length > 0 && (
        <aside className="product-gallery-shortlist" aria-label="Your selected inspiration films">
          <div>
            <strong>
              {shortlist.length > MAX_SHORTLIST
                ? `${shortlist.length} films saved`
                : `${shortlist.length} of ${MAX_SHORTLIST} films saved`}
            </strong>
            {shortlist.length > MAX_SHORTLIST && (
              <p
                id={`${galleryId}-shortlist-limit`}
                className="product-gallery-shortlist-limit"
                role="status"
              >
                Your older shortlist is preserved. Remove {shortlist.length - MAX_SHORTLIST}{' '}
                {shortlist.length - MAX_SHORTLIST === 1 ? 'film' : 'films'} before using it. A
                creation can use up to {MAX_SHORTLIST} films.
              </p>
            )}
            <p>
              Bring their cited techniques into a new creation. Original footage stays at its
              source.
            </p>
            <ul>
              {selectedProducts.map(
                (product) =>
                  product && (
                    <li key={product.film.id}>
                      <span>{product.film.brand}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${product.film.brand}: ${product.film.title} from shortlist`}
                        onClick={() => toggleSaved(product)}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </li>
                  ),
              )}
            </ul>
          </div>
          <div className="product-gallery-shortlist-actions">
            <button
              type="button"
              className="product-gallery-primary"
              disabled={shortlist.length > MAX_SHORTLIST}
              aria-describedby={
                shortlist.length > MAX_SHORTLIST ? `${galleryId}-shortlist-limit` : undefined
              }
              onClick={() => useSelection(shortlist)}
            >
              Use saved films <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => {
                saveShortlist([]);
                setSelectionError('');
                setStatus('Shortlist cleared.');
              }}
            >
              Clear shortlist
            </button>
          </div>
        </aside>
      )}
      <p className="product-gallery-footnote">
        Campaigns and independent spec films are labeled. Choosing a reference carries links and
        creative context into your video, with no footage copied.
      </p>
    </section>
  );
}

export default ProductGallery;
