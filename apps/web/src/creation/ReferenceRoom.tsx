import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { rovingIndex } from '../creator/keyboard';
import { ProductGallery } from '../inspiration/ProductGallery';
import { PosterWorkspace } from '../posters/PosterWorkspace';
import './creation.css';

export function ReferenceRoom({
  onUseReferences,
  onDirty,
}: {
  onUseReferences(ids: string[]): void;
  onDirty(value: boolean): void;
}) {
  const [tab, setTab] = useState<'films' | 'posters'>('films');
  const tabId = useId();
  const dirtyCallback = useRef(onDirty);
  dirtyCallback.current = onDirty;
  const reportDirty = useCallback((value: boolean) => dirtyCallback.current(value), []);
  useEffect(() => () => dirtyCallback.current(false), []);
  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = rovingIndex(event.key, tab === 'films' ? 0 : 1, 2);
    if (next === null) return;
    event.preventDefault();
    setTab(next === 0 ? 'films' : 'posters');
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return (
    <section className="creation-reference-room" aria-label="Inspiration">
      <div className="reference-room-toolbar">
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
        <p>Find a style for your business.</p>
      </div>
      <div
        id={`${tabId}-films-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-films-tab`}
        hidden={tab !== 'films'}
      >
        <ProductGallery onUseReferences={onUseReferences} active={tab === 'films'} />
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
