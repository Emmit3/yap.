import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, FilmSlate, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { CreatorExternalReference } from '@yap/contracts/creator';
import {
  externalFilmEmbed,
  filmMatches,
  loadFilmCatalog,
  selectedFilm,
  type FilmReference,
} from './references';

export function ReferenceBoard({
  selected,
  onSelect,
  onRemove,
  disabled,
}: {
  selected: CreatorExternalReference[];
  onSelect(reference: CreatorExternalReference): void;
  onRemove(id: string): void;
  disabled: boolean;
}) {
  const [films, setFilms] = useState<FilmReference[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [limit, setLimit] = useState(8);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void loadFilmCatalog(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setFilms(value);
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setError(caught instanceof Error ? caught.message : 'Campaign catalog not available.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);
  const categories = useMemo(
    () => [...new Set(films.map((film) => film.category))].sort(),
    [films],
  );
  const filtered = useMemo(
    () => films.filter((film) => filmMatches(film, search, category)),
    [films, category, search],
  );

  return (
    <section className="creator-reference-board" aria-labelledby="creator-catalog-title">
      <div className="creator-section-title">
        <div>
          <span className="creator-kicker">The reference room</span>
          <h2 id="creator-catalog-title">Study the craft.</h2>
          <p>Choose a technique. Make the story your own.</p>
        </div>
        <span className="creator-count">{selected.length} / 12 selected</span>
      </div>
      <p className="creator-fineprint">
        Films open on their original sites. Selections save cited techniques as creative context;
        campaign footage is never copied into your film.
      </p>
      {selected.length > 0 && (
        <div className="creator-selected-references" aria-label="Selected film references">
          {selected.map((film) => (
            <div key={film.id}>
              <FilmSlate size={18} />
              <span>
                <strong>{film.title}</strong>
                <small>{film.techniques.join(' / ')}</small>
              </span>
              <button
                type="button"
                className="creator-icon-button"
                disabled={disabled}
                onClick={() => onRemove(film.id)}
                aria-label={`Remove ${film.title}`}
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="creator-reference-controls">
        <label className="creator-search">
          <MagnifyingGlass size={18} />
          <input
            ref={searchInput}
            aria-label="Search film references"
            placeholder="Brand, film or technique"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(8);
            }}
          />
        </label>
        <label className="creator-category">
          Category
          <select
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
              setLimit(8);
            }}
          >
            <option value="all">All categories</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? (
        <div className="creator-catalog-loading" role="status">
          Loading source verified films…
        </div>
      ) : error ? (
        <div className="creator-inline-error" role="alert">
          <p>{error}</p>
          <button className="creator-text-button" onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <p className="creator-result-count" role="status">
            {filtered.length} {filtered.length === 1 ? 'film' : 'films'} in this view
          </p>
          {!filtered.length && (
            <div className="creator-catalog-loading">
              <h3>No films match these filters.</h3>
              <p>Try another brand or technique, or return to the full reference room.</p>
              <button
                type="button"
                className="creator-secondary-button"
                onClick={() => {
                  setSearch('');
                  setCategory('all');
                  setLimit(8);
                  setPreviewId(null);
                  searchInput.current?.focus();
                }}
              >
                Clear filters
              </button>
            </div>
          )}
          <div className="creator-film-grid">
            {filtered.slice(0, limit).map((film) => {
              const embed = externalFilmEmbed(film.watchUrl);
              const saved = selected.find((item) => item.id === film.id);
              const techniques = choices[film.id] ?? saved?.techniques ?? [];
              return (
                <article className="creator-film-card" key={film.id}>
                  <div className="creator-film-meta">
                    <span>{film.brand || film.category}</span>
                    <span>
                      {film.kind === 'spec'
                        ? 'Spec film'
                        : film.kind === 'unclear'
                          ? 'Reference'
                          : 'Campaign'}
                      {film.year ? ` / ${film.year}` : ''}
                    </span>
                  </div>
                  <h3>{film.title}</h3>
                  <p className="creator-film-credit">
                    {[film.product, film.creator || 'See source for credits']
                      .filter(Boolean)
                      .join(' / ')}
                  </p>
                  <p>{film.whyItFits}</p>
                  <fieldset
                    className="creator-techniques"
                    disabled={disabled || (!saved && selected.length >= 12)}
                  >
                    <legend>Techniques to borrow</legend>
                    {film.techniques.map((technique) => (
                      <label key={technique}>
                        <input
                          type="checkbox"
                          checked={techniques.includes(technique)}
                          onChange={(event) =>
                            setChoices((previous) => ({
                              ...previous,
                              [film.id]: event.target.checked
                                ? [...techniques, technique]
                                : techniques.filter((value) => value !== technique),
                            }))
                          }
                        />
                        <span>{technique}</span>
                      </label>
                    ))}
                  </fieldset>
                  <details>
                    <summary>Source evidence</summary>
                    <p>{film.evidence}</p>
                    {film.videoEvidence && <p>{film.videoEvidence}</p>}
                    <p className="creator-fineprint">The technique rationale is editorial.</p>
                  </details>
                  <div className="creator-film-actions">
                    <a href={film.watchUrl} target="_blank" rel="noreferrer noopener">
                      Watch at source <ArrowUpRight size={16} />
                    </a>
                    <button
                      type="button"
                      disabled={disabled || !techniques.length || (!saved && selected.length >= 12)}
                      onClick={() => onSelect(selectedFilm(film, techniques))}
                    >
                      {saved ? <Check size={16} /> : <FilmSlate size={16} />}{' '}
                      {saved ? 'Update techniques' : 'Use techniques'}
                    </button>
                  </div>
                  {embed && (
                    <button
                      type="button"
                      className="creator-text-button"
                      aria-expanded={previewId === film.id}
                      onClick={() =>
                        setPreviewId((previous) => (previous === film.id ? null : film.id))
                      }
                    >
                      {previewId === film.id
                        ? 'Close external preview'
                        : 'Preview creator film here'}{' '}
                      <FilmSlate size={16} />
                    </button>
                  )}
                  {embed && previewId === film.id && (
                    <div className="creator-external-film">
                      <iframe
                        src={embed.src}
                        title={`${film.title} / external ${embed.provider} film`}
                        allow="fullscreen; picture-in-picture"
                        allowFullScreen
                        loading="lazy"
                        referrerPolicy="strict-origin-when-cross-origin"
                      />
                      <p className="creator-fineprint">
                        External creator film from {embed.provider}. If this player is unavailable,
                        use the original watch link above. Playback starts only when you choose it.
                      </p>
                    </div>
                  )}
                  <a
                    className="creator-source-link"
                    href={film.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Original case and credits <ArrowUpRight size={12} />
                  </a>
                </article>
              );
            })}
          </div>
          {filtered.length > limit && (
            <button
              className="creator-secondary-button creator-more"
              onClick={() => setLimit((value) => value + 12)}
            >
              Explore more films
            </button>
          )}
        </>
      )}
    </section>
  );
}
