import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, FilmStrip, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { Workflow } from '@yap/contracts/workflow';
import { ErrorNotice, LoadingState, PageHeading, timeAgo } from '../components';
import { isPromoAbort, promoApi, promoMessage } from './api';
import './promo.css';

export interface PromoLibraryProps {
  onCreate(): void;
  onOpen(id: string): void;
}

function statusOf(workflow: Workflow) {
  const script =
    workflow.script?.sourceRevision === workflow.contentRevision ? workflow.script : null;
  const scenes = script && workflow.scenes?.sourceScriptId === script.id ? workflow.scenes : null;

  if (
    scenes &&
    workflow.approvals.brief === workflow.contentRevision &&
    workflow.approvals.script === script?.id &&
    workflow.approvals.scenes === scenes.id
  ) {
    return { kind: 'approved', label: 'Approved for render' };
  }
  if (scenes) return { kind: 'review', label: 'Ready for review' };
  if (script) return { kind: 'script', label: 'Script prepared' };
  return { kind: 'brief', label: 'Brief in progress' };
}

export function PromoLibrary({ onCreate, onOpen }: PromoLibraryProps) {
  const [search, setSearch] = useState('');
  const [promos, setPromos] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const latestRequest = useRef(0);
  const query = search.trim();

  useEffect(() => {
    const controller = new AbortController();
    const request = ++latestRequest.current;
    const isCurrent = () => !controller.signal.aborted && request === latestRequest.current;
    setLoading(true);
    setError('');

    const timer = setTimeout(
      async () => {
        try {
          const workflows = await promoApi.list(query, controller.signal);
          if (isCurrent()) {
            setPromos([...workflows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
          }
        } catch (caught) {
          if (isCurrent() && !isPromoAbort(caught)) setError(promoMessage(caught));
        } finally {
          if (isCurrent()) setLoading(false);
        }
      },
      query ? 250 : 0,
    );

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, reloadKey]);

  return (
    <div className="promo promo-library">
      <PageHeading
        eyebrow="Your studio"
        title="Your promos"
        copy="Continue a saved promo, or start with your business and photos."
      >
        <button className="button button-primary" onClick={onCreate}>
          <Plus size={18} /> New promo
        </button>
      </PageHeading>

      <div className="promo-search">
        <label htmlFor="promo-library-search">Search saved promos</label>
        <div className="search-field">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <input
            id="promo-library-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a promo or product"
            maxLength={200}
            autoComplete="off"
          />
        </div>
      </div>

      <section aria-label="Saved promos" aria-busy={loading}>
        {error ? (
          <ErrorNotice message={error} onRetry={() => setReloadKey((key) => key + 1)} />
        ) : loading ? (
          <LoadingState label="Loading saved promos" />
        ) : promos.length === 0 ? (
          <div className="promo-empty">
            {query ? <MagnifyingGlass size={32} /> : <FilmStrip size={36} weight="light" />}
            <h2>{query ? 'No matching promos' : 'Your first promo starts here.'}</h2>
            <p>
              {query
                ? 'Try a different product or promo name.'
                : 'Bring a few photos and tell us what you want people to know.'}
            </p>
            {query ? (
              <button className="button button-secondary" onClick={() => setSearch('')}>
                Clear search
              </button>
            ) : (
              <button className="button button-primary" onClick={onCreate}>
                <Plus size={18} /> Create your first promo
              </button>
            )}
          </div>
        ) : (
          <div className="promo-list">
            {promos.map((promo) => {
              const status = statusOf(promo);
              return (
                <article
                  className="promo-card"
                  key={promo.id}
                  aria-labelledby={`promo-${promo.id}`}
                >
                  <div className="promo-card__meta">
                    <span className="promo-status" data-status={status.kind}>
                      {status.label}
                    </span>
                    <time
                      dateTime={promo.updatedAt}
                      title={new Date(promo.updatedAt).toLocaleString()}
                    >
                      Updated {timeAgo(promo.updatedAt)}
                    </time>
                  </div>
                  <h2 id={`promo-${promo.id}`}>{promo.title}</h2>
                  <p>{promo.brief.productName ?? 'Product details to add'}</p>
                  <button
                    className="button button-secondary"
                    onClick={() => onOpen(promo.id)}
                    aria-label={`Open ${promo.title}`}
                  >
                    Open promo <ArrowUpRight size={18} />
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
