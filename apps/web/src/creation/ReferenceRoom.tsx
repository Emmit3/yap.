import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { DotsThree, X } from '@phosphor-icons/react';
import { rovingIndex } from '../creator/keyboard';
import { ProductGallery } from '../inspiration/ProductGallery';
import { PosterWorkspace } from '../posters/PosterWorkspace';
import './creation.css';
import '../posters/poster-room.css';

export function ReferenceRoom({
  onUseReferences,
  onDirty,
  posters,
}: {
  onUseReferences(ids: string[]): void;
  onDirty(value: boolean): void;
  /** Poster styles are installed on this server. Without them the room shows videos only. */
  posters: boolean;
}) {
  const [tab, setTab] = useState<'films' | 'posters'>('films');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const tabId = useId();
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;
  const reportDirty = useCallback((value: boolean) => dirtyCallback.current(value), []);
  useEffect(() => () => dirtyCallback.current(false), []);
  useEffect(() => {
    if (!navigationOpen) return;
    document.querySelector<HTMLElement>('.side-nav button')?.focus({ preventScroll: true });
    const close = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setNavigationOpen(false);
      navigationToggle.current?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [navigationOpen]);
  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = rovingIndex(event.key, tab === 'films' ? 0 : 1, 2);
    if (next === null) return;
    event.preventDefault();
    setTab(next === 0 ? 'films' : 'posters');
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return (
    <section
      className="creation-reference-room"
      aria-label="Inspiration"
      data-view={tab}
      data-navigation-open={navigationOpen || undefined}
    >
      <div className="reference-room-toolbar">
        <button
          ref={navigationToggle}
          className="inspiration-menu-toggle"
          type="button"
          aria-label={navigationOpen ? 'Close workspace navigation' : 'Open workspace navigation'}
          aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen((value) => !value)}
        >
          {navigationOpen ? <X size={18} /> : <DotsThree size={22} />}
        </button>
        {posters && (
          <div
            className="creation-view-tabs reference-room-tabs"
            role="tablist"
            aria-label="Inspiration formats"
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
                {value === 'films' ? 'Videos' : 'Posters'}
              </button>
            ))}
          </div>
        )}
        <p>Find a style for your business.</p>
      </div>
      <div
        id={`${tabId}-films-panel`}
        role={posters ? 'tabpanel' : undefined}
        aria-labelledby={posters ? `${tabId}-films-tab` : undefined}
        hidden={tab !== 'films'}
      >
        <ProductGallery onUseReferences={onUseReferences} active={tab === 'films'} />
      </div>
      {posters && (
        <div
          id={`${tabId}-posters-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-posters-tab`}
          hidden={tab !== 'posters'}
        >
          <PosterWorkspace onDirty={reportDirty} active={tab === 'posters'} />
        </div>
      )}
    </section>
  );
}
