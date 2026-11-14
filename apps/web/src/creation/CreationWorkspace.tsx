import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ChartBar, FilmSlate, Image, PencilSimple } from '@phosphor-icons/react';
import type { SocialHandoff } from '@yap/contracts/social';
import type { CreatorExternalReference } from '@yap/contracts/creator';
import { CreatorWorkspace } from '../creator/CreatorWorkspace';
import { loadFilmCatalog, selectedFilm } from '../creator/references';
import { PromoWorkspace } from '../promo/PromoWorkspace';
import SocialWorkspace from '../social/SocialWorkspace';
import { validateResearchContext } from '../research-context';
import { applyCreationResearch, type CreationContext, type CreationKind } from './research';
import './creation.css';

export interface CreationWorkspaceProps {
  kind?: CreationKind;
  id?: string;
  initialResearch?: SocialHandoff;
  initialReferenceIds?: string[];
  initialView?: 'create' | 'analytics';
  onBack(): void;
  onCreated(id: string, kind: CreationKind): void;
  onDirty(dirty: boolean): void;
  onOpenPromo(workflowId: string): void;
}

const noIds: string[] = [];
export function CreationWorkspace({
  kind: initialKind = 'video',
  id,
  initialResearch,
  initialReferenceIds = noIds,
  initialView = 'create',
  onBack,
  onCreated,
  onDirty,
  onOpenPromo,
}: CreationWorkspaceProps) {
  const [kind, setKind] = useState(initialKind);
  const [view, setView] = useState(initialView);
  const [analyticsOpened, setAnalyticsOpened] = useState(initialView === 'analytics');
  const [research, setResearch] = useState(initialResearch);
  const [context, setContext] = useState<CreationContext>({
    topic: initialResearch?.topic ?? '',
    audience: initialResearch?.audience,
  });
  const [contextLoading, setContextLoading] = useState(Boolean(id));
  const [references, setReferences] = useState<CreatorExternalReference[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(!id && initialReferenceIds.length > 0);
  const [creatorDirty, setCreatorDirty] = useState(false);
  const [analyticsDirty, setAnalyticsDirty] = useState(false);
  const [pendingKind, setPendingKind] = useState<CreationKind | null>(null);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [hydratedResource, setHydratedResource] = useState<string>();
  const resourceId = id ?? hydratedResource ?? context.resourceId;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [applying, setApplying] = useState(false);
  const dirtyRef = useRef(false);
  const applyingRef = useRef(false);
  const applyingController = useRef<AbortController | null>(null);
  const callbacks = useRef({ onDirty, onCreated });
  callbacks.current = { onDirty, onCreated };
  const tabs = useId();
  const paneHeading = useRef<HTMLHeadingElement>(null);
  const changeCreatorDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
    setCreatorDirty(dirty);
  }, []);
  const changeContext = useCallback((next: CreationContext) => {
    setContext((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    if (next.resourceId) {
      setResearch(next.research);
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    callbacks.current.onDirty(
      creatorDirty || analyticsDirty || applying || (!resourceId && Boolean(research)),
    );
  }, [creatorDirty, analyticsDirty, applying, resourceId, research]);
  useEffect(() => {
    if (resourceId || context.isBusy || applying) setPendingKind(null);
  }, [resourceId, context.isBusy, applying]);
  useEffect(
    () => () => {
      applyingController.current?.abort();
      callbacks.current.onDirty(false);
    },
    [],
  );
  useEffect(() => {
    if (id || !initialReferenceIds.length) return;
    const controller = new AbortController();
    void loadFilmCatalog(controller.signal)
      .then((films) => {
        if (controller.signal.aborted) return;
        const resolved = [...new Set(initialReferenceIds)].map((filmId) =>
          films.find((film) => film.id === filmId),
        );
        if (resolved.length > 12 || resolved.some((film) => !film))
          throw new Error(
            'Some selected films are unavailable. Return to the reference room to choose them again.',
          );
        setReferences(resolved.map((film) => selectedFilm(film!, film!.techniques)));
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted)
          setError(
            caught instanceof Error ? caught.message : 'Film references could not be loaded.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setReferencesLoading(false);
      });
    return () => controller.abort();
  }, [id, initialReferenceIds]);

  function openView(next: 'create' | 'analytics', focusContent = false) {
    if (applying) return;
    setView(next);
    if (next === 'analytics') setAnalyticsOpened(true);
    if (focusContent) requestAnimationFrame(() => paneHeading.current?.focus());
  }
  function changeKind(next: CreationKind) {
    if (resourceId || context.isBusy) return;
    if (next === kind || applying) return;
    if (dirtyRef.current) {
      setPendingKind(next);
      return;
    }
    setKind(next);
    setNotice('');
  }
  async function useResearch(handoff: SocialHandoff) {
    if (context.isBusy)
      throw new Error(
        'Wait for the current creation action to finish before applying research. Your research stays here.',
      );
    if (applyingRef.current)
      throw new Error('Research is already being applied. Wait for the saved result.');
    const validated = validateResearchContext(handoff);
    if (!resourceId) {
      setResearch(validated);
      setNotice(
        'Selected decisions are attached to this creation. Your own facts and photos stay separate.',
      );
      openView('create', true);
      return;
    }
    applyingRef.current = true;
    setApplying(true);
    setError('');
    const controller = new AbortController();
    applyingController.current = controller;
    try {
      await applyCreationResearch(
        kind,
        resourceId,
        validated,
        controller.signal,
        () => dirtyRef.current,
      );
      if (controller.signal.aborted) return;
      setResearch(validated);
      setHydratedResource(resourceId);
      setEditorEpoch((previous) => previous + 1);
      setNotice(
        'Research saved to this creation. Rebuild the proposal and review it again; previous approvals are cleared.',
      );
      setView('create');
      requestAnimationFrame(() => paneHeading.current?.focus());
    } finally {
      if (applyingController.current === controller) {
        applyingController.current = null;
        applyingRef.current = false;
        if (!controller.signal.aborted) setApplying(false);
      }
    }
  }
  const editorKey = `${kind}-${id ?? 'new'}-${editorEpoch}`;
  return (
    <section className="creation-workspace" aria-label="Creation and research workspace">
      <header className="creation-controls">
        <div>
          <p className="creation-kicker">One idea. Your creative workspace.</p>
          <h1 ref={paneHeading} tabIndex={-1}>
            {view === 'analytics'
              ? 'Research that shapes the story.'
              : id
                ? 'Keep shaping your creation.'
                : 'What will you make?'}
          </h1>
        </div>
        <div className="creation-view-tabs" role="tablist" aria-label="Creation views">
          {(['create', 'analytics'] as const).map((pane) => (
            <button
              key={pane}
              id={`${tabs}-${pane}`}
              type="button"
              role="tab"
              aria-selected={view === pane}
              aria-controls={`${tabs}-${pane}-panel`}
              tabIndex={view === pane ? 0 : -1}
              disabled={applying}
              onClick={() => openView(pane)}
              onKeyDown={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'create'
                      : event.key === 'End'
                        ? 'analytics'
                        : pane === 'create'
                          ? 'analytics'
                          : 'create';
                  openView(next);
                  document.getElementById(`${tabs}-${next}`)?.focus();
                }
              }}
            >
              {pane === 'create' ? <PencilSimple size={18} /> : <ChartBar size={18} />}
              {pane === 'create' ? 'Create' : 'View analytics'}
            </button>
          ))}
        </div>
      </header>
      {error && (
        <p className="creation-message creation-message-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="creation-message" role="status">
          {notice}
        </p>
      )}
      {pendingKind && (
        <div className="creation-message" role="alert">
          <p>
            Switching creation formats discards unsaved editor changes. Your research remains in
            this workspace.
          </p>
          <button className="text-button" onClick={() => setPendingKind(null)}>
            Keep editing
          </button>
          <button
            className="text-button"
            disabled={Boolean(resourceId || context.isBusy)}
            onClick={() => {
              if (resourceId || context.isBusy) return;
              changeCreatorDirty(false);
              setKind(pendingKind);
              setPendingKind(null);
            }}
          >
            Discard edits and switch
          </button>
        </div>
      )}
      <div
        id={`${tabs}-create-panel`}
        role="tabpanel"
        aria-labelledby={`${tabs}-create`}
        hidden={view !== 'create'}
        inert={applying}
      >
        {!resourceId && (
          <div className="creation-format" aria-label="Creation format">
            <span>Make it with</span>
            <button
              type="button"
              aria-pressed={kind === 'video'}
              onClick={() => changeKind('video')}
            >
              <FilmSlate size={18} />
              Generated video
            </button>
            <button
              type="button"
              aria-pressed={kind === 'photo'}
              onClick={() => changeKind('photo')}
            >
              <Image size={18} />
              Your photos
            </button>
          </div>
        )}
        {research && (
          <div className="creation-research-link">
            <div>
              <strong>{research.topic}</strong>
              <p>
                {research.sourceUrls.length} attributed sources inform this direction. Creator facts
                remain your own.
              </p>
            </div>
            <button className="text-button" onClick={() => openView('analytics', true)}>
              Review research <ArrowRight size={16} />
            </button>
          </div>
        )}
        {referencesLoading ? (
          <p role="status" className="creation-message">
            Opening your selected film references…
          </p>
        ) : kind === 'video' ? (
          <CreatorWorkspace
            key={editorKey}
            id={id ?? hydratedResource}
            onBack={onBack}
            onCreated={(created) => callbacks.current.onCreated(created, 'video')}
            onDirty={changeCreatorDirty}
            initialResearch={id ? undefined : research}
            initialExternalReferences={id ? undefined : references}
            onContextChange={changeContext}
            onOpenPromo={onOpenPromo}
          />
        ) : (
          <PromoWorkspace
            key={editorKey}
            id={id ?? hydratedResource}
            onBack={onBack}
            onCreated={(created) => callbacks.current.onCreated(created, 'photo')}
            onDirty={changeCreatorDirty}
            research={id ? undefined : research}
            onContextChange={changeContext}
          />
        )}
      </div>
      <div
        id={`${tabs}-analytics-panel`}
        role="tabpanel"
        aria-labelledby={`${tabs}-analytics`}
        hidden={view !== 'analytics'}
      >
        <p className="creation-analytics-intro">
          Explore examples, connections, and creative decisions for this creation. Switching views
          preserves your editor and research drafts.
        </p>
        {resourceId && (
          <p className="creation-analytics-boundary">
            Applying a different direction clears saved proposals and approvals. Save your creation
            edits first; no video is generated or approved by research.
          </p>
        )}
        {research && (
          <details className="creation-saved-context">
            <summary>Direction saved with this creation · {research.topic}</summary>
            <p>{research.creativeDirection}</p>
            {research.cautions.length > 0 && (
              <ul>
                {research.cautions.map((caution, index) => (
                  <li key={index}>{caution}</li>
                ))}
              </ul>
            )}
            <ul>
              {research.sourceUrls.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
            <p>
              Detailed graphs load from the saved investigation below. This attributed snapshot
              remains available if the investigation was deleted.
            </p>
          </details>
        )}
        {contextLoading ? (
          <div className="creation-message" role="status">
            <p>
              {context.isBusy
                ? 'Opening saved creation and its research context…'
                : 'Load this saved creation to open its linked research. If loading failed, retry it in Create.'}
            </p>
            <button className="text-button" onClick={() => openView('create', true)}>
              Open creation
            </button>
          </div>
        ) : (
          analyticsOpened && (
            <SocialWorkspace
              key="creation-analytics"
              embedded
              initialTopic={context.topic || research?.topic}
              initialAudience={context.audience || research?.audience}
              initialInvestigationId={research?.investigationId}
              onDirty={setAnalyticsDirty}
              onUseResearch={useResearch}
            />
          )
        )}
      </div>
    </section>
  );
}
