import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, FilmSlate } from '@phosphor-icons/react';
import { loadFilmCatalog } from '../creator/references';
import { rovingIndex } from '../creator/keyboard';
import { PosterWorkspace } from '../posters/PosterWorkspace';
import { referenceIdsFromMessage } from './bridge';
import { createReferenceCatalogReader } from './reference-loader';
import './creation.css';

export function ReferenceRoom({
  onUseReferences,
  onDirty,
}: {
  onUseReferences(ids: string[]): void;
  onDirty(value: boolean): void;
}) {
  const [tab, setTab] = useState<'films' | 'posters'>('films');
  const activeTab = useRef(tab);
  activeTab.current = tab;
  const tabId = useId();
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;
  const reportDirty = useCallback((value: boolean) => dirtyCallback.current(value), []);
  useEffect(() => () => dirtyCallback.current(false), []);
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const callback = useRef(onUseReferences);
  callback.current = onUseReferences;
  useEffect(() => {
    const controller = new AbortController();
    const readCatalog = createReferenceCatalogReader(() => loadFilmCatalog(controller.signal));
    // A click can arrive after the frame loads. Retain the failure for that click without an
    // unhandled rejection, and keep the original external links usable inside the frame.
    void readCatalog().catch(() => undefined);
    const receive = (event: MessageEvent<unknown>) => {
      if (activeTab.current !== 'films') return;
      const ids = referenceIdsFromMessage(
        event,
        window.location.origin,
        frame.current?.contentWindow ?? null,
      );
      if (!ids) return;
      void readCatalog()
        .then((films) => {
          if (controller.signal.aborted || activeTab.current !== 'films') return;
          const known = new Set(films.map((film) => film.id));
          if (ids.some((id) => !known.has(id)))
            throw new Error(
              'This selection is no longer in the reference library. Reload the room and try again.',
            );
          setError('');
          callback.current(ids);
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted)
            setError(
              caught instanceof Error ? caught.message : 'The references could not be selected.',
            );
        });
    };
    window.addEventListener('message', receive);
    return () => {
      controller.abort();
      window.removeEventListener('message', receive);
    };
  }, [revision]);
  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = rovingIndex(event.key, tab === 'films' ? 0 : 1, 2);
    if (next === null) return;
    event.preventDefault();
    setTab(next === 0 ? 'films' : 'posters');
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return (
    <section className="creation-reference-room" aria-label="Reference room">
      <div className="reference-room-toolbar">
        <div
          className="creation-view-tabs reference-room-tabs"
          role="tablist"
          aria-label="Reference types"
          aria-orientation="horizontal"
          onKeyDown={moveTab}
        >
          {(['films', 'posters'] as const).map((value) => (
            <button
              key={value}
              id={`${tabId}-${value}-tab`}
              type="button"
              role="tab"
              aria-selected={tab === value}
              aria-controls={`${tabId}-${value}-panel`}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
            >
              {value === 'films' ? 'Films' : 'Posters'}
            </button>
          ))}
        </div>
        <p>Study the originals. Find your own direction.</p>
      </div>
      <div
        id={`${tabId}-films-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-films-tab`}
        hidden={tab !== 'films'}
      >
        <div className="creation-reference-intro">
          <FilmSlate size={22} />
          <p>
            Watch the originals. Choose references to bring their cited techniques into a new
            creation.
          </p>
          <a href="/showcase/film-references.html" target="_blank" rel="noopener noreferrer">
            Open full page <ArrowUpRight size={15} />
          </a>
        </div>
        {error && (
          <div className="creation-message creation-message-error" role="alert">
            <p>{error} Select again to retry, or reload the room.</p>
            <button
              className="text-button"
              onClick={() => {
                setError('');
                setRevision((value) => value + 1);
              }}
            >
              Reload reference room
            </button>
          </div>
        )}
        <iframe
          key={revision}
          ref={frame}
          src="/showcase/film-references.html?embedded=1"
          title="Interactive film reference library"
          className="creation-reference-frame"
          allow="fullscreen"
        />
      </div>
      <div
        id={`${tabId}-posters-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-posters-tab`}
        hidden={tab !== 'posters'}
      >
        <PosterWorkspace onDirty={reportDirty} active={tab === 'posters'} />
      </div>
    </section>
  );
}
