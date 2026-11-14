import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, FilmSlate } from '@phosphor-icons/react';
import { loadFilmCatalog } from '../creator/references';
import { referenceIdsFromMessage } from './bridge';
import './creation.css';

export function ReferenceRoom({ onUseReferences }: { onUseReferences(ids: string[]): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState('');
  const callback = useRef(onUseReferences);
  callback.current = onUseReferences;
  useEffect(() => {
    const controller = new AbortController();
    const catalog = loadFilmCatalog(controller.signal);
    // A click can arrive after the frame loads. Retain the failure for that click without an
    // unhandled rejection, and keep the original external links usable inside the frame.
    void catalog.catch(() => undefined);
    const receive = (event: MessageEvent<unknown>) => {
      const ids = referenceIdsFromMessage(
        event,
        window.location.origin,
        frame.current?.contentWindow ?? null,
      );
      if (!ids) return;
      void catalog
        .then((films) => {
          if (controller.signal.aborted) return;
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
  }, []);
  return (
    <section className="creation-reference-room" aria-label="Film reference room">
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
        <p className="creation-message creation-message-error" role="alert">
          {error}
        </p>
      )}
      <iframe
        ref={frame}
        src="/showcase/film-references.html?embedded=1"
        title="Interactive film reference library"
        className="creation-reference-frame"
        allow="fullscreen"
      />
    </section>
  );
}
