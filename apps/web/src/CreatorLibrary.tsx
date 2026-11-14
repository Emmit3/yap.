import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, FilmSlate, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { CreatorSession } from '@yap/contracts/creator';
import { creatorApi, creatorMessage } from './creator/api';
import './creator-library.css';

export function CreatorLibrary({
  onCreate,
  onOpen,
}: {
  onCreate(): void;
  onOpen(id: string): void;
}) {
  const [sessions, setSessions] = useState<CreatorSession[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    creatorApi
      .list(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSessions(result.sessions);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(creatorMessage(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return sessions.filter(
      (session) =>
        !term ||
        `${session.input.prompt} ${session.input.location ?? ''}`
          .toLocaleLowerCase()
          .includes(term),
    );
  }, [sessions, query]);
  return (
    <section className="creator-library" aria-labelledby="film-library-title">
      <header className="creator-library__heading">
        <div>
          <span className="eyebrow">Your production desk</span>
          <h1 id="film-library-title">Ideas worth coming back to.</h1>
          <p>
            Your brief, references, script and clips stay together. Pick up a saved film or start
            with something new.
          </p>
        </div>
        <button className="button button-primary" onClick={onCreate}>
          <Plus size={18} />
          New film
        </button>
      </header>
      <label className="creator-library__search">
        <MagnifyingGlass size={20} />
        <span className="sr-only">Search your films</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          placeholder="Find an idea, product or place"
          maxLength={200}
        />
      </label>
      {loading ? (
        <div className="creator-library__empty" role="status">
          Loading your saved films…
        </div>
      ) : error ? (
        <div className="creator-library__empty" role="alert">
          <p>{error}</p>
          <button
            className="button button-secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="creator-library__empty">
          <FilmSlate size={40} weight="light" />
          <h2>{query ? 'No films match that search.' : 'Your next film starts with an idea.'}</h2>
          <p>
            {query
              ? 'Try another product or place.'
              : 'Add your own media, describe a product, or start with a public project link.'}
          </p>
          {!query && (
            <button className="button button-primary" onClick={onCreate}>
              Start a film
              <ArrowUpRight size={18} />
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="creator-library__count" aria-live="polite">
            {filtered.length} saved {filtered.length === 1 ? 'film' : 'films'}
          </p>
          <div className="creator-library__grid">
            {filtered.map((session) => (
              <button
                className="creator-library__film"
                key={session.id}
                onClick={() => onOpen(session.id)}
              >
                <div className="creator-library__film-top">
                  <FilmSlate size={24} weight="light" />
                  <span>
                    {session.approval
                      ? 'Approval recorded'
                      : session.plan
                        ? 'Shot plan saved'
                        : session.research
                          ? 'Direction research'
                          : 'Developing the idea'}
                  </span>
                  <ArrowUpRight size={18} />
                </div>
                <h2>
                  {session.answers.find((answer) => answer.questionId === 'productName')?.answer ||
                    session.input.prompt}
                </h2>
                <p>{session.input.prompt}</p>
                <footer>
                  <span>
                    {session.input.duration ?? 15}s · {session.input.platform ?? 'instagram'}
                  </span>
                  <time dateTime={session.updatedAt}>
                    {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
                      new Date(session.updatedAt),
                    )}
                  </time>
                </footer>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
