import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ArrowsClockwise,
  Camera,
  ChatCircleText,
  Check,
  Copy,
  DownloadSimple,
  FilmSlate,
  Heart,
  ImageSquare,
  LinkSimple,
  MapPin,
  PaperPlaneTilt,
  Plus,
  Rows,
  SlidersHorizontal,
  Stop,
  TextT,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import type { SocialHandoff } from '@yap/contracts/social';
import type {
  CreatorClip,
  CreatorExternalReference,
  CreatorJob,
  CreatorSource,
} from '@yap/contracts/creator';
import { LoadingState } from '../components';
import { promoApi } from '../promo/api';
import { creatorApi } from './api';
import { fetchCreatorVideo } from './downloads';
import { rovingIndex } from './keyboard';
import {
  approvalCurrent,
  clipPreviewIsCurrent,
  combineScriptMoments,
  isActiveJob,
  nextQuestion,
  outputIsCurrent,
  planCurrent,
} from './model';
import { ReferenceBoard } from './ReferenceBoard';
import { BudgetReview } from './BudgetReview';
import { useCreatorSession, type CreatorController, type SourceForm } from './useCreatorSession';
import './creator.css';

export interface CreatorWorkspaceProps {
  id?: string;
  onBack(): void;
  onCreated(id: string): void;
  onDirty(dirty: boolean): void;
  initialResearch?: SocialHandoff;
  initialExternalReferences?: CreatorExternalReference[];
  onContextChange?(context: {
    topic: string;
    audience?: string;
    research?: SocialHandoff;
    resourceId?: string;
    isBusy?: boolean;
  }): void;
  onOpenPromo(workflowId: string): void;
}
type View = 'guided' | 'director';
const viewKey = 'yap.creator.view';
function initialView(): View {
  try {
    return sessionStorage.getItem(viewKey) === 'director' ? 'director' : 'guided';
  } catch {
    return 'guided';
  }
}
const bytesLabel = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const platformNames: Record<string, string> = {
  x: 'X',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  web: 'Web',
  context: 'Product context',
};
const platformName = (platform?: string) => platformNames[platform ?? 'web'] ?? 'Source';

function moveTab(
  event: KeyboardEvent<HTMLDivElement>,
  current: number,
  onSelect: (index: number) => void,
) {
  const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  const next = rovingIndex(event.key, current, tabs.length);
  if (next === null) return;
  event.preventDefault();
  onSelect(next);
  tabs[next]?.focus();
}

export function CreatorWorkspace(props: CreatorWorkspaceProps) {
  const c = useCreatorSession(props);
  const contextCallback = useRef(props.onContextChange);
  contextCallback.current = props.onContextChange;
  const context = {
    topic: c.source.prompt,
    audience: c.state?.workflow.brief.audience,
    research: c.state?.workflow.research ?? props.initialResearch,
    resourceId: c.state?.session.id,
    isBusy: Boolean(c.busy || c.loading),
  };
  const contextRef = useRef(context);
  contextRef.current = context;
  const contextKey = JSON.stringify(context);
  useEffect(() => contextCallback.current?.(contextRef.current), [contextKey]);
  const [view, setView] = useState<View>(initialView);
  const [selectedShot, setSelectedShot] = useState(0);
  const [inspector, setInspector] = useState<'shots' | 'script'>('shots');
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const scriptTimingInput = useRef<HTMLInputElement>(null);
  const state = c.state;
  const active = isActiveJob(c.job);
  const production = active && c.job?.kind === 'production';
  const locked = Boolean(c.busy) || c.needsReload || production;
  const edits =
    c.inputDirty ||
    c.planDirty ||
    c.scriptDirty ||
    c.answersDirty ||
    c.photoEditsDirty ||
    c.photos.length > 0;
  const sourceLocked =
    locked ||
    Boolean(
      state &&
      (c.planDirty || c.scriptDirty || c.answersDirty || c.photoEditsDirty || c.reply.trim()),
    );
  const savedPhotoLocked =
    locked ||
    c.inputDirty ||
    c.planDirty ||
    c.scriptDirty ||
    c.answersDirty ||
    Boolean(c.reply.trim()) ||
    c.photos.length > 0;
  const answerLocked =
    locked ||
    c.inputDirty ||
    c.planDirty ||
    c.scriptDirty ||
    c.answersDirty ||
    c.photoEditsDirty ||
    c.photos.length > 0;

  function changeView(next: View, focusPanel = true) {
    setView(next);
    try {
      sessionStorage.setItem(viewKey, next);
    } catch {
      /* The current view still works. */
    }
    if (focusPanel) requestAnimationFrame(() => panelHeading.current?.focus());
  }
  function reviewSavedTiming() {
    setInspector('script');
    changeView('director', false);
    requestAnimationFrame(() => (scriptTimingInput.current ?? panelHeading.current)?.focus());
  }
  useEffect(() => {
    if (c.plan && selectedShot >= c.plan.clips.length) setSelectedShot(0);
  }, [c.plan, selectedShot]);

  if (c.loading)
    return (
      <div className="creator-workspace">
        <LoadingState label="Opening your creator studio" />
      </div>
    );
  if (props.id && !state)
    return (
      <section className="creator-workspace creator-unavailable">
        <FilmSlate size={40} weight="light" />
        <h1>Your film could not be opened.</h1>
        <p>{c.error || 'The saved studio is unavailable.'}</p>
        <div className="creator-actions">
          <button className="creator-primary-button" onClick={c.reload}>
            Try again
          </button>
          <button className="creator-text-button" onClick={props.onBack}>
            Back to your workspace
          </button>
        </div>
      </section>
    );

  return (
    <div className={`creator-workspace creator-view-${view}`}>
      <input
        ref={fileInput}
        type="file"
        className="creator-file-input"
        accept="image/jpeg,image/png,image/webp"
        multiple
        aria-label="Add product photos"
        onChange={(event) => {
          c.addPhotos([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
        disabled={sourceLocked}
      />
      <header className="creator-head">
        <div>
          <button className="creator-back" onClick={props.onBack}>
            <ArrowLeft size={16} /> Your workspace
          </button>
          <h1>{state ? state.workflow.title : 'Make room for your next idea.'}</h1>
          <p>
            {state
              ? 'One film. Two ways to shape it.'
              : 'A few photos. A little direction. Something worth watching.'}
          </p>
        </div>
        <div className="creator-head-controls">
          <span className={`creator-save-state ${c.dirty ? 'is-unsaved' : ''}`}>
            <span />
            {c.busy
              ? c.busy
              : c.dirty
                ? 'Local changes'
                : state
                  ? 'Saved to your studio'
                  : 'Your starting point'}
          </span>
          <div
            className="creator-view-switch"
            role="tablist"
            aria-label="Creation view"
            onKeyDown={(event) =>
              moveTab(event, view === 'guided' ? 0 : 1, (index) =>
                changeView(index === 0 ? 'guided' : 'director', false),
              )
            }
          >
            <button
              role="tab"
              id="creator-guided-tab"
              aria-selected={view === 'guided'}
              tabIndex={view === 'guided' ? 0 : -1}
              aria-controls="creator-view-panel"
              onClick={() => changeView('guided')}
            >
              <ChatCircleText size={17} /> Guided
            </button>
            <button
              role="tab"
              id="creator-director-tab"
              aria-selected={view === 'director'}
              tabIndex={view === 'director' ? 0 : -1}
              aria-controls="creator-view-panel"
              onClick={() => changeView('director')}
            >
              <Rows size={17} /> Director
            </button>
          </div>
        </div>
      </header>

      {c.error && (
        <div className="creator-feedback creator-feedback-error" role="alert">
          <WarningCircle size={20} />
          <div>
            <p>{c.error}</p>
            {c.needsReload && (
              <>
                <p>
                  Local text and edits are kept. Reload to compare with the saved version before
                  retrying.
                </p>
                <button className="creator-text-button" onClick={c.reload}>
                  Reload saved state <ArrowsClockwise size={15} />
                </button>
              </>
            )}
          </div>
          <button className="creator-icon-button" onClick={c.clearError} aria-label="Dismiss error">
            <X size={16} />
          </button>
        </div>
      )}
      {c.notice && (
        <p className="creator-notice" role="status">
          {c.notice}
        </p>
      )}
      {c.needsReload && !c.error && (
        <div className="creator-feedback" role="alert">
          <p>
            The saved state must be reloaded before continuing. Local edits are kept for comparison.
          </p>
          <button className="creator-secondary-button" onClick={c.reload}>
            Reload saved state <ArrowsClockwise size={16} />
          </button>
        </div>
      )}
      {props.initialResearch && !state && (
        <aside className="creator-context-note">
          <LinkSimple size={18} />
          <p>
            <strong>Research is coming with you.</strong> {props.initialResearch.topic} /{' '}
            {props.initialResearch.sourceUrls.length} attributed sources. These guide the creative
            direction; your own facts and photos remain separate.
          </p>
        </aside>
      )}
      {state && edits && (
        <div className="creator-draft-bar">
          <span>Save your local changes before preparing or approving a film.</span>
          <button className="creator-text-button" onClick={c.useSaved} disabled={Boolean(c.busy)}>
            Use saved text, answers, descriptions and plan
          </button>
        </div>
      )}
      {state?.workflow.script && !state.session.plan && (
        <aside className="creator-feedback">
          <TextT size={20} />
          <div>
            <p>
              <strong>Your saved script is ready to edit.</strong>
            </p>
            <p>
              Review the timing, save your changes, then prepare again. Your existing words are
              kept; preparing resumes from the saved drafting progress.
            </p>
            <button className="creator-text-button" onClick={reviewSavedTiming}>
              Edit saved script timing <ArrowUpRight size={16} />
            </button>
          </div>
        </aside>
      )}

      <section id="creator-view-panel" role="tabpanel" aria-labelledby={`creator-${view}-tab`}>
        {view === 'guided' ? (
          <div className="creator-guided-layout">
            {/* A new creation already opens under two headings; a third only pushes the composer down. */}
            <h2
              ref={panelHeading}
              tabIndex={-1}
              className={state ? 'creator-panel-title' : 'creator-panel-title sr-only'}
            >
              {state ? 'Let’s find the story.' : 'What are we making?'}
            </h2>
            <div className="creator-guided-main">
              {state && <Conversation c={c} />}
              <SourceComposer
                c={c}
                fileInput={fileInput}
                promptInput={promptInput}
                locked={sourceLocked}
                active={active}
              />
              {state && <QuestionComposer c={c} disabled={answerLocked} />}
              {state && (
                <div className="creator-next-step">
                  <div>
                    <span className="creator-kicker">When the direction feels right</span>
                    <h3>Give it a script. Then a shot.</h3>
                    <p>Prepare an editable proposal from your saved sources and answers.</p>
                  </div>
                  <button
                    className="creator-primary-button"
                    onClick={c.prepare}
                    disabled={locked || active || c.dirty}
                  >
                    {state.session.plan ? 'Refresh the proposal' : 'Prepare script and shots'}
                    <ArrowRight size={17} />
                  </button>
                  {state.session.plan && (
                    <button className="creator-text-button" onClick={() => changeView('director')}>
                      Review in Director <ArrowUpRight size={16} />
                    </button>
                  )}
                </div>
              )}
            </div>
            <aside className="creator-guided-aside">
              <SourceBin
                c={c}
                onAdd={() => fileInput.current?.click()}
                disabled={sourceLocked}
                savedPhotoDisabled={savedPhotoLocked}
              />
              <WorkflowProgress c={c} />
            </aside>
          </div>
        ) : (
          <>
            <div className="creator-director-heading">
              <h2 ref={panelHeading} tabIndex={-1}>
                Your director’s desk.
              </h2>
              <span className="creator-fineprint">
                Sources, words and every shot. All in one place.
              </span>
            </div>
            {(!state?.session.plan || c.photos.length > 0 || c.inputDirty) && (
              <SourceComposer
                c={c}
                fileInput={fileInput}
                promptInput={promptInput}
                locked={sourceLocked}
                active={active}
              />
            )}
            <div className="creator-director-layout">
              <aside className="creator-source-pane">
                <SourceBin
                  c={c}
                  onAdd={() => fileInput.current?.click()}
                  disabled={sourceLocked}
                  savedPhotoDisabled={savedPhotoLocked}
                />
                <WorkflowProgress c={c} />
              </aside>
              <div className="creator-stage-pane">
                <ScenePreview c={c} clip={c.plan?.clips[selectedShot]} />
                <ShotStrip c={c} selected={selectedShot} onSelect={setSelectedShot} />
                {state && !state.session.plan && (
                  <div className="creator-empty-plan">
                    <h3>The first frame is a plan.</h3>
                    <p>
                      Save your sources, then prepare the script and shots. You’ll review everything
                      here before any paid generation.
                    </p>
                    <button
                      className="creator-primary-button"
                      disabled={locked || active || c.dirty}
                      onClick={c.prepare}
                    >
                      Prepare my proposal <ArrowRight size={17} />
                    </button>
                  </div>
                )}
              </div>
              <aside className="creator-inspector">
                <div
                  className="creator-inspector-tabs"
                  role="tablist"
                  aria-label="Director tools"
                  onKeyDown={(event) =>
                    moveTab(event, inspector === 'shots' ? 0 : 1, (index) =>
                      setInspector(index === 0 ? 'shots' : 'script'),
                    )
                  }
                >
                  <button
                    role="tab"
                    id="creator-shots-tab"
                    aria-selected={inspector === 'shots'}
                    tabIndex={inspector === 'shots' ? 0 : -1}
                    aria-controls="creator-inspector-panel"
                    onClick={() => setInspector('shots')}
                  >
                    <SlidersHorizontal size={16} /> Shot direction
                  </button>
                  <button
                    role="tab"
                    id="creator-script-tab"
                    aria-selected={inspector === 'script'}
                    tabIndex={inspector === 'script' ? 0 : -1}
                    aria-controls="creator-inspector-panel"
                    onClick={() => setInspector('script')}
                  >
                    <TextT size={16} /> Script
                  </button>
                </div>
                <div
                  id="creator-inspector-panel"
                  role="tabpanel"
                  aria-labelledby={`creator-${inspector}-tab`}
                >
                  {inspector === 'shots' ? (
                    <ShotInspector
                      c={c}
                      index={selectedShot}
                      disabled={
                        locked ||
                        active ||
                        c.inputDirty ||
                        c.scriptDirty ||
                        c.answersDirty ||
                        c.photoEditsDirty ||
                        Boolean(c.reply.trim()) ||
                        c.photos.length > 0
                      }
                    />
                  ) : (
                    <ScriptInspector
                      c={c}
                      timingInputRef={scriptTimingInput}
                      disabled={
                        locked ||
                        active ||
                        c.inputDirty ||
                        c.planDirty ||
                        c.answersDirty ||
                        c.photoEditsDirty ||
                        Boolean(c.reply.trim()) ||
                        c.photos.length > 0
                      }
                    />
                  )}
                </div>
              </aside>
            </div>
            {state && <QuestionComposer c={c} disabled={answerLocked} />}
            {state && (
              <SavedAnswers
                c={c}
                disabled={
                  locked ||
                  c.inputDirty ||
                  c.planDirty ||
                  c.scriptDirty ||
                  c.photoEditsDirty ||
                  Boolean(c.reply.trim()) ||
                  c.photos.length > 0
                }
              />
            )}
          </>
        )}
      </section>

      {state && <ResearchPanel c={c} disabled={locked || edits || Boolean(c.reply.trim())} />}
      <details className="creator-reference-disclosure">
        <summary>
          <FilmSlate size={21} />
          <span>
            <strong>Open the reference room</strong>
            <small>
              Professional product films. Original sources. Techniques to make your own.
            </small>
          </span>
          <Plus size={20} />
        </summary>
        <ReferenceBoard
          selected={c.externalReferences}
          onSelect={c.selectExternal}
          onRemove={c.removeExternal}
          disabled={locked || Boolean(state && (edits || c.reply.trim()))}
        />
      </details>
      {state?.session.plan && (
        <BudgetReview c={c} onOpenPromo={() => props.onOpenPromo(state.workflow.id)} />
      )}
      {c.job && <JobPanel c={c} job={c.job} />}
      {state && !state.session.plan && (
        <div className="creator-alternative">
          <p>Prefer a simple film made from your photos?</p>
          <button
            className="creator-text-button"
            disabled={Boolean(c.busy) || production || c.dirty}
            onClick={() => props.onOpenPromo(state.workflow.id)}
          >
            Continue in the photo editor <ArrowUpRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function SourceComposer({
  c,
  fileInput,
  promptInput,
  locked,
  active,
}: {
  c: CreatorController;
  fileInput: RefObject<HTMLInputElement | null>;
  promptInput: RefObject<HTMLTextAreaElement | null>;
  locked: boolean;
  active: boolean;
}) {
  const set = <K extends keyof SourceForm>(key: K, value: SourceForm[K]) =>
    c.setSource((previous) => ({ ...previous, [key]: value }));
  // A new creation needs an idea or at least one photo before it can start.
  const empty = !c.state && !c.source.prompt.trim() && !c.photos.length;
  return (
    <section className="creator-source-composer" aria-label="Your starting sources">
      <div className="creator-composer-tools">
        <button type="button" disabled={locked} onClick={() => fileInput.current?.click()}>
          <ImageSquare size={18} /> Add media
        </button>
        <button
          type="button"
          disabled={locked}
          onClick={() => {
            set('mode', 'text');
            promptInput.current?.focus();
          }}
        >
          <TextT size={18} /> Add text
        </button>
        <span>Product photos and your own words</span>
      </div>
      <label className="creator-input-label" htmlFor="creator-idea">
        {c.state ? 'The idea behind this film' : 'Tell us what should come to life.'}
      </label>
      <textarea
        ref={promptInput}
        id="creator-idea"
        className="creator-idea"
        value={c.source.prompt}
        onChange={(event) => set('prompt', event.target.value)}
        maxLength={8000}
        disabled={locked}
        placeholder="A short film for my matcha shop. The strawberry matcha is the star. I want it to feel like a quiet Saturday morning…"
      />
      <div className="creator-format-controls">
        <label>
          Format
          <select
            value={c.source.platform}
            onChange={(event) => set('platform', event.target.value as SourceForm['platform'])}
            disabled={locked}
          >
            <option value="instagram">Instagram Reels</option>
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube Shorts</option>
          </select>
        </label>
        <label>
          Length
          <select
            value={c.source.duration}
            onChange={(event) =>
              set('duration', Number(event.target.value) as SourceForm['duration'])
            }
            disabled={locked}
          >
            {[15, 30, 60].map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds} seconds
              </option>
            ))}
          </select>
        </label>
        <label>
          Tone
          <select
            value={c.source.tone}
            onChange={(event) => set('tone', event.target.value as SourceForm['tone'])}
            disabled={locked}
          >
            <option value="conversational">Conversational</option>
            <option value="educational">Educational</option>
            <option value="bold">Bold</option>
          </select>
        </label>
      </div>
      <details className="creator-context-fields">
        <summary>Add a location or source links</summary>
        <div className="creator-context-grid">
          <label>
            <span>
              <MapPin size={14} /> Location
            </span>
            <input
              value={c.source.location}
              onChange={(event) => set('location', event.target.value)}
              maxLength={200}
              placeholder="Business location or setting"
              disabled={locked}
            />
          </label>
          <label>
            <span>
              <LinkSimple size={14} /> Product or GitHub links
            </span>
            <textarea
              value={c.source.urls}
              onChange={(event) => set('urls', event.target.value)}
              maxLength={10240}
              placeholder="Public HTTPS links, one per line"
              disabled={locked}
            />
          </label>
        </div>
      </details>
      <div className="creator-composer-bottom">
        <span>
          {empty && !locked && !active
            ? 'Describe your idea or add a photo to start.'
            : 'JPEG, PNG or WebP photos / up to 10 MiB each'}
        </span>
        <button
          className="creator-primary-button"
          onClick={c.state ? c.saveSources : c.create}
          disabled={
            locked ||
            active ||
            empty ||
            (!c.source.prompt.trim() && Boolean(c.state)) ||
            Boolean(
              c.state && (c.planDirty || c.scriptDirty || c.answersDirty || c.reply.trim()),
            ) ||
            Boolean(c.state && !c.inputDirty && !c.photos.length)
          }
        >
          {c.state ? 'Save sources' : 'Start my film'}
          <ArrowRight size={17} />
        </button>
      </div>
    </section>
  );
}

function SourceBin({
  c,
  onAdd,
  disabled,
  savedPhotoDisabled,
}: {
  c: CreatorController;
  onAdd(): void;
  disabled: boolean;
  savedPhotoDisabled: boolean;
}) {
  const assets = c.state?.workflow.assets ?? [];
  return (
    <section className="creator-source-bin" aria-label="Source bin">
      <div className="creator-small-heading">
        <h3>Your sources</h3>
        <button
          className="creator-icon-button"
          onClick={onAdd}
          disabled={disabled}
          aria-label="Add product photos"
        >
          <Plus size={17} />
        </button>
      </div>
      <div className="creator-source-items">
        {assets.map((asset) => (
          <figure className="creator-source-card" key={asset.id}>
            <img
              src={promoApi.assetUrl(c.state!.workflow.id, asset.id)}
              alt={asset.description || asset.filename}
              loading="lazy"
            />
            <figcaption>
              <strong>{asset.filename}</strong>
              <span>
                <Check size={12} /> Saved photo / {asset.width} × {asset.height}
              </span>
              <label>
                Photo description
                <textarea
                  aria-label={`Description of ${asset.filename}`}
                  value={c.photoEdits[asset.id] ?? asset.description}
                  maxLength={2000}
                  disabled={savedPhotoDisabled}
                  onChange={(event) =>
                    c.setPhotoEdits((previous) => ({ ...previous, [asset.id]: event.target.value }))
                  }
                  placeholder="Describe what this photo shows."
                  rows={3}
                />
              </label>
              <div className="creator-photo-actions">
                <button
                  className="creator-text-button"
                  aria-label={`Save description for ${asset.filename}`}
                  disabled={
                    savedPhotoDisabled ||
                    (c.photoEdits[asset.id] ?? asset.description) === asset.description
                  }
                  onClick={() => c.savePhotoDescription(asset.id)}
                >
                  Save description
                </button>
                <button
                  className="creator-text-button"
                  aria-label={`Remove ${asset.filename}`}
                  disabled={savedPhotoDisabled || c.photoEditsDirty}
                  onClick={() => c.removePhoto(asset.id)}
                >
                  Remove photo
                </button>
              </div>
            </figcaption>
          </figure>
        ))}
        {c.photos.map((photo) => (
          <figure className="creator-source-card creator-pending-source" key={photo.id}>
            <img src={photo.preview} alt={photo.description || photo.file.name} />
            <figcaption>
              <strong>{photo.file.name}</strong>
              <span>Ready to upload / {bytesLabel(photo.file.size)}</span>
              <label>
                What should we notice?
                <input
                  value={photo.description}
                  maxLength={2000}
                  disabled={disabled}
                  onChange={(event) =>
                    c.setPhotos((previous) =>
                      previous.map((item) =>
                        item.id === photo.id ? { ...item, description: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <button
                className="creator-text-button"
                disabled={disabled}
                onClick={() => {
                  URL.revokeObjectURL(photo.preview);
                  c.setPhotos((previous) => previous.filter((item) => item.id !== photo.id));
                }}
              >
                Remove photo
              </button>
            </figcaption>
          </figure>
        ))}
        {c.source.prompt.trim() && (
          <article className="creator-text-source">
            <TextT size={20} />
            <strong>Your starting idea</strong>
            <p>{c.source.prompt}</p>
            <span>{c.inputDirty ? 'Local text' : 'Saved text'}</span>
          </article>
        )}
        {!assets.length && !c.photos.length && !c.source.prompt.trim() && (
          <div className="creator-source-empty">
            <ImageSquare size={28} weight="light" />
            <p>Your photos and ideas will collect here.</p>
            <span>Only your supplied media becomes a production asset.</span>
          </div>
        )}
      </div>
      {assets.length > 0 && (
        <p className="creator-fineprint">
          Saving a description or removing a photo updates your sources and clears the current plan
          approval. Prepare and review the film again before paid work.
        </p>
      )}
      {c.photoEditsDirty && (
        <p className="creator-fineprint">
          Save your photo description changes, or use the saved descriptions, before changing other
          parts of the film.
        </p>
      )}
    </section>
  );
}

function WorkflowProgress({ c }: { c: CreatorController }) {
  const state = c.state;
  const research = state?.session.research;
  const complete = Boolean(state && outputIsCurrent(c.job, state.session, state.workflow));
  const steps = [
    {
      name: 'Sources',
      detail: state ? 'Saved starting point' : 'Add your starting point',
      done: Boolean(state),
    },
    {
      name: 'Direction',
      detail: research
        ? research.sources.length
          ? `${research.sources.length} cited sources`
          : 'Saved with research limits'
        : c.job?.kind === 'analysis' && isActiveJob(c.job)
          ? 'Research in progress'
          : 'Research when you’re ready',
      done: Boolean(research),
    },
    {
      name: 'Proposal',
      detail: state?.session.plan
        ? `${state.session.plan.clips.length} planned shots`
        : 'Script and shot direction',
      done: Boolean(state && planCurrent(state.session, state.workflow)),
    },
    {
      name: 'Review',
      detail:
        state && approvalCurrent(state.session, state.workflow)
          ? 'This version approved'
          : 'Your approval comes first',
      done: Boolean(state && approvalCurrent(state.session, state.workflow)),
    },
    {
      name: 'Film',
      detail: complete ? 'Completed and audited' : 'Generate after approval',
      done: complete,
    },
  ];
  return (
    <section className="creator-progress" aria-label="Film progress">
      <h3>A film, taking shape.</h3>
      <ol>
        {steps.map((step, index) => (
          <li key={step.name} className={step.done ? 'is-complete' : ''}>
            <span>{step.done ? <Check size={13} /> : index + 1}</span>
            <div>
              <strong>{step.name}</strong>
              <small>{step.detail}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Conversation({ c }: { c: CreatorController }) {
  const state = c.state!;
  return (
    <div className="creator-conversation">
      <div className="creator-conversation-intro">
        <span className="creator-voice-mark">y.</span>
        <p>
          Your starting point is saved. We’ll separate the product facts from the creative
          references, then shape a script and a shot plan you can review.
        </p>
      </div>
      {state.session.answers.map((answer) => {
        const question =
          state.session.research?.questions.find((item) => item.id === answer.questionId)
            ?.question ??
          state.workflow.questions.find((item) => item.id === answer.questionId)?.question ??
          'Your direction';
        return (
          <article className="creator-conversation-turn" key={answer.questionId}>
            <p>{question}</p>
            <blockquote>{answer.answer}</blockquote>
            <span>
              <Check size={12} /> Saved answer
            </span>
          </article>
        );
      })}
    </div>
  );
}

function QuestionComposer({ c, disabled }: { c: CreatorController; disabled: boolean }) {
  const state = c.state!;
  const question = c.replyQuestion ?? nextQuestion(state.session, state.workflow);
  if (!question)
    return (
      <div className="creator-answers-complete">
        <Check size={18} />
        <p>
          Your current questions are answered. You can refine the direction by editing your sources
          or selected references.
        </p>
      </div>
    );
  return (
    <section className="creator-question" aria-labelledby="creator-question-title">
      <span className="creator-kicker">One useful detail</span>
      <h3 id="creator-question-title">{question.question}</h3>
      <p>{question.why}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          c.answer(question.id);
        }}
      >
        <label className="creator-input-label" htmlFor="creator-answer">
          Your answer
        </label>
        <textarea
          id="creator-answer"
          value={c.reply}
          onChange={(event) => c.writeReply(question, event.target.value)}
          maxLength={2000}
          placeholder="Tell us in your own words…"
          disabled={disabled}
        />
        <div>
          <span>{c.reply.length} / 2,000</span>
          <button
            className="creator-primary-button"
            disabled={
              disabled ||
              !c.reply.trim() ||
              c.inputDirty ||
              c.planDirty ||
              c.scriptDirty ||
              Boolean(c.photos.length)
            }
            type="submit"
          >
            Save direction <PaperPlaneTilt size={17} />
          </button>
        </div>
      </form>
    </section>
  );
}

function SavedAnswers({ c, disabled }: { c: CreatorController; disabled: boolean }) {
  if (!c.state?.session.answers.length) return null;
  const state = c.state;
  return (
    <details className="creator-saved-answers" open>
      <summary>
        <TextT size={18} /> Review and correct your answers
      </summary>
      <p className="creator-fineprint">
        These saved answers guide both views. Corrections clear the previous plan approval.
      </p>
      <fieldset disabled={disabled}>
        {state.session.answers.map((answer) => {
          const title =
            state.session.research?.questions.find((question) => question.id === answer.questionId)
              ?.question ??
            state.workflow.questions.find((question) => question.id === answer.questionId)
              ?.question ??
            answer.questionId;
          return (
            <label key={answer.questionId}>
              {title}
              <textarea
                maxLength={2000}
                value={c.answerEdits[answer.questionId] ?? answer.answer}
                onChange={(event) =>
                  c.setAnswerEdits((previous) => ({
                    ...previous,
                    [answer.questionId]: event.target.value,
                  }))
                }
              />
            </label>
          );
        })}
      </fieldset>
      <button
        className="creator-secondary-button"
        disabled={disabled || !c.answersDirty}
        onClick={c.saveSavedAnswers}
      >
        Save corrected direction <Check size={16} />
      </button>
    </details>
  );
}

function ResearchPanel({ c, disabled }: { c: CreatorController; disabled: boolean }) {
  const [filter, setFilter] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const research = c.state!.session.research;
  const running = c.job?.kind === 'analysis' && isActiveJob(c.job);
  const sources =
    research?.sources.filter(
      (source) => filter === 'all' || source.platform === filter || source.kind === filter,
    ) ?? [];
  return (
    <section className="creator-research" aria-labelledby="creator-research-title">
      <div className="creator-section-title">
        <div>
          <span className="creator-kicker">Research, alongside your idea</span>
          <h2 id="creator-research-title">A little context. A stronger direction.</h2>
          <p>Public sources inform the craft. Your own facts stay yours.</p>
        </div>
        <button
          className="creator-secondary-button"
          disabled={disabled || running || isActiveJob(c.job)}
          onClick={c.analyze}
        >
          <ArrowsClockwise size={16} />
          {research ? 'Research again' : 'Start research'}
        </button>
      </div>
      {running && (
        <div className="creator-research-live" role="status">
          <span className="creator-working-dot" />
          <p>Research is running. You can answer the next question while sources are collected.</p>
          <button className="creator-text-button" onClick={c.cancel} disabled={Boolean(c.busy)}>
            Stop research
          </button>
        </div>
      )}
      {!research && !running && (
        <div className="creator-research-empty">
          <p>
            {c.capabilities?.researchConfigured === false
              ? 'Live research is not configured on this server. You can still supply facts, answer questions and prepare a guided proposal.'
              : 'Start research when the idea is ready. Source availability and any gaps will be shown here.'}
          </p>
          {c.capabilityError && <small>{c.capabilityError}</small>}
        </div>
      )}
      {research && (
        <>
          <p className="creator-research-summary">{research.summary}</p>
          {research.coverage && (
            <div className="creator-coverage" aria-label="Source coverage">
              {research.coverage.map((branch) => (
                <div key={branch.branch}>
                  <strong>
                    {branch.branch === 'cinematography'
                      ? 'Cinematography'
                      : platformName(branch.branch)}
                  </strong>
                  <span>{branch.status}</span>
                  <p>{branch.message}</p>
                </div>
              ))}
            </div>
          )}
          {!!research.limitations.length && (
            <details className="creator-limitations">
              <summary>What the sources could not establish</summary>
              <ul>
                {research.limitations.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="creator-source-filters" aria-label="Research sources">
            {[
              ['all', 'All sources'],
              ['cinematography', 'The craft'],
              ['x', 'X'],
              ['tiktok', 'TikTok'],
              ['instagram', 'Instagram'],
              ['product', 'Product'],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={filter === key}
                onClick={() => {
                  setFilter(key!);
                  setShowAll(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="creator-research-sources">
            {sources.slice(0, showAll ? sources.length : 6).map((source) => (
              <ResearchSourceCard key={source.id} source={source} />
            ))}
          </div>
          {!sources.length && (
            <p className="creator-fineprint">
              No sources were retrieved for this view. No examples have been invented.
            </p>
          )}
          {sources.length > 6 && (
            <button className="creator-text-button" onClick={() => setShowAll((value) => !value)}>
              {showAll ? 'Show fewer sources' : `Show all ${sources.length} sources`}
            </button>
          )}
          {!!research.references.length && (
            <div className="creator-research-directions">
              <h3>Directions worth exploring.</h3>
              <p className="creator-fineprint">
                Save a direction to inform the proposal. Source media is not attached to your film.
              </p>
              <div>
                {research.references.map((reference) => {
                  const selected = c.state!.session.selectedReferenceIds.includes(reference.id);
                  return (
                    <article key={reference.id}>
                      <div>
                        <h4>{reference.title}</h4>
                        <button
                          className="creator-reference-like"
                          aria-label={`${selected ? 'Remove' : 'Save'} ${reference.title}`}
                          aria-pressed={selected}
                          disabled={disabled}
                          onClick={() => c.selectReference(reference.id)}
                        >
                          <Heart size={20} weight={selected ? 'fill' : 'regular'} />
                        </button>
                      </div>
                      <strong>{reference.hook}</strong>
                      <p>{reference.visualDirection}</p>
                      <p className="creator-fineprint">{reference.rationale}</p>
                      <div className="creator-reference-citations">
                        {reference.sourceIds.map((id) => {
                          const source = research.sources.find((item) => item.id === id);
                          return source ? (
                            <a href={source.url} target="_blank" rel="noreferrer noopener" key={id}>
                              {source.title}
                              <ArrowUpRight size={12} />
                            </a>
                          ) : null;
                        })}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ResearchSourceCard({ source }: { source: CreatorSource }) {
  return (
    <article className="creator-research-source">
      <span>
        {source.kind === 'cinematography'
          ? 'Professional craft reference'
          : source.kind === 'github'
            ? 'Repository context'
            : platformName(source.platform)}
      </span>
      <h3>
        <a href={source.url} target="_blank" rel="noreferrer noopener">
          {source.title}
          <ArrowUpRight size={15} />
        </a>
      </h3>
      <p>{source.excerpt}</p>
      <small>
        {source.contentKind === 'search_result'
          ? 'Search excerpt'
          : source.contentKind === 'repository'
            ? 'Repository source'
            : 'Source page'}
        {source.provider ? ` / ${source.provider}` : ''}
        {source.collectedAt
          ? ` / Retrieved ${new Date(source.collectedAt).toLocaleDateString()}`
          : ''}
      </small>
    </article>
  );
}

function ScenePreview({ c, clip }: { c: CreatorController; clip?: CreatorClip }) {
  const asset = c.state?.workflow.assets.find((item) => item.id === clip?.assetId);
  const receipt =
    c.state && clipPreviewIsCurrent(c.job, c.state.session, c.state.workflow) && c.job
      ? [...c.job.clips]
          .reverse()
          .find((item) => item.clipId === clip?.id && item.status === 'passed')
      : null;
  return (
    <section className="creator-scene-preview" aria-label="Selected shot preview">
      <div className="creator-stage-top">
        <span>Portrait canvas</span>
        <span>9:16 / silent clip</span>
      </div>
      <div className="creator-film-stage">
        {receipt && c.job ? (
          <video
            key={`${c.job.id}-${receipt.clipId}-${receipt.attempt}`}
            src={creatorApi.clipUrl(c.job.sessionId, c.job.id, receipt.clipId, receipt.attempt)}
            controls
            playsInline
            preload="metadata"
            aria-label="Generated clip preview"
          />
        ) : asset && c.state ? (
          <>
            <img
              src={promoApi.assetUrl(c.state.workflow.id, asset.id)}
              alt={asset.description || asset.filename}
            />
            <span className="creator-preview-label">Source photo / scene direction preview</span>
          </>
        ) : (
          <div className="creator-canvas-empty">
            <Camera size={38} weight="light" />
            <p>{clip ? 'This shot starts with a direction.' : 'Your next first frame.'}</p>
            <small>
              {clip
                ? 'Generated footage appears after approval and a completed audit.'
                : 'Add your sources and prepare the shot plan.'}
            </small>
          </div>
        )}
      </div>
      <p>{clip?.prompt || 'A place to see the idea, before the world does.'}</p>
    </section>
  );
}

function ShotStrip({
  c,
  selected,
  onSelect,
}: {
  c: CreatorController;
  selected: number;
  onSelect(index: number): void;
}) {
  if (!c.plan) return null;
  return (
    <div className="creator-shot-strip" role="group" aria-label="Shot selection">
      {c.plan.clips.map((clip, index) => {
        const asset = c.state?.workflow.assets.find((item) => item.id === clip.assetId);
        return (
          <button
            key={clip.id}
            aria-pressed={selected === index}
            tabIndex={selected === index ? 0 : -1}
            onClick={() => onSelect(index)}
            onKeyDown={(event) => {
              const next = rovingIndex(event.key, index, c.plan!.clips.length);
              if (next === null) return;
              event.preventDefault();
              onSelect(next);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('button')
                [next]?.focus();
            }}
          >
            <div>
              {asset && c.state ? (
                <img src={promoApi.assetUrl(c.state.workflow.id, asset.id)} alt="" />
              ) : (
                <FilmSlate size={24} weight="light" />
              )}
              <span>{clip.seconds}s</span>
            </div>
            <strong>Shot {String(index + 1).padStart(2, '0')}</strong>
            <small>{clip.camera}</small>
          </button>
        );
      })}
    </div>
  );
}

function ShotInspector({
  c,
  index,
  disabled,
}: {
  c: CreatorController;
  index: number;
  disabled: boolean;
}) {
  const clip = c.plan?.clips[index];
  const minimumSeconds =
    c.state?.session.plan?.provider === 'fal' ||
    c.state?.session.plan?.model === 'seedance-v1.5-pro'
      ? 4
      : 2;
  if (!clip)
    return (
      <div className="creator-inspector-empty">
        <SlidersHorizontal size={28} weight="light" />
        <p>Shot controls appear when your proposal is prepared.</p>
      </div>
    );
  const update = <K extends keyof CreatorClip>(field: K, value: CreatorClip[K]) =>
    c.setPlan((previous) =>
      previous
        ? {
            ...previous,
            clips: previous.clips.map((item, i) =>
              i === index ? { ...item, [field]: value } : item,
            ),
          }
        : null,
    );
  return (
    <div className="creator-shot-inspector">
      <div className="creator-small-heading">
        <h3>Shot {index + 1}</h3>
        <span>{clip.seconds} seconds</span>
      </div>
      <fieldset disabled={disabled}>
        <label>
          Direction
          <textarea
            value={clip.prompt}
            maxLength={1000}
            onChange={(event) => update('prompt', event.target.value)}
          />
        </label>
        <label>
          Camera movement
          <textarea
            value={clip.camera}
            maxLength={1000}
            onChange={(event) => update('camera', event.target.value)}
          />
        </label>
        <label>
          Lighting
          <textarea
            value={clip.lighting}
            maxLength={1000}
            onChange={(event) => update('lighting', event.target.value)}
          />
        </label>
        <label>
          Clip duration
          <input
            type="number"
            min={minimumSeconds}
            max={10}
            step={1}
            value={clip.seconds}
            onChange={(event) => update('seconds', Number(event.target.value))}
          />
          <small className="creator-fineprint">
            This model accepts {minimumSeconds} to 10 seconds per clip.
          </small>
        </label>
        <label>
          Source photo
          <select
            value={clip.assetId ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              c.setPlan((previous) =>
                previous
                  ? {
                      ...previous,
                      clips: previous.clips.map((item, i) => {
                        if (i !== index) return item;
                        const { assetId: _old, ...rest } = item;
                        return value ? { ...rest, assetId: value } : rest;
                      }),
                    }
                  : null,
              );
            }}
          >
            <option value="">Text direction only</option>
            {c.state?.workflow.assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.filename}
              </option>
            ))}
          </select>
        </label>
        <label>
          Post caption
          <textarea
            value={c.plan?.caption ?? ''}
            maxLength={3000}
            onChange={(event) =>
              c.setPlan((previous) =>
                previous ? { ...previous, caption: event.target.value } : null,
              )
            }
          />
        </label>
      </fieldset>
      <SoundControls c={c} disabled={disabled} />
      <button
        className="creator-primary-button"
        disabled={disabled || !c.planDirty || c.inputDirty || c.scriptDirty}
        onClick={c.savePlan}
      >
        Save shot changes <Check size={16} />
      </button>
      <p className="creator-fineprint">Saving changes clears the previous approval.</p>
    </div>
  );
}

function ScriptInspector({
  c,
  disabled,
  timingInputRef,
}: {
  c: CreatorController;
  disabled: boolean;
  timingInputRef: RefObject<HTMLInputElement | null>;
}) {
  if (!c.script)
    return (
      <div className="creator-inspector-empty">
        <TextT size={28} weight="light" />
        <p>The script appears after you prepare the proposal.</p>
      </div>
    );
  const segments = c.script.segments;
  const totalSeconds = segments.reduce((total, segment) => total + segment.seconds, 0);
  const targetSeconds = c.state?.workflow.brief.duration;
  return (
    <div className="creator-script-inspector">
      <h3>The words behind it.</h3>
      <p className="creator-fineprint" role="status">
        {totalSeconds} seconds in this script
        {targetSeconds ? ` / ${targetSeconds} seconds requested` : ''}.
        {c.capabilities &&
          ` Each moment needs at least ${c.capabilities.provider === 'fal' ? 4 : 2} seconds for ${c.capabilities.provider === 'fal' ? 'Seedance' : 'Runway'}.`}
      </p>
      <fieldset disabled={disabled}>
        <label>
          Opening hook
          <textarea
            value={c.script.hook}
            maxLength={1000}
            onChange={(event) =>
              c.setScript((previous) =>
                previous ? { ...previous, hook: event.target.value } : null,
              )
            }
          />
        </label>
        {segments.map((segment, index) => {
          const combination = combineScriptMoments(segments, index);
          const hasNext = index < segments.length - 1;
          return (
            <div className="creator-script-moment" key={segment.id}>
              <label>
                Moment {index + 1}
                <textarea
                  value={segment.text}
                  maxLength={2000}
                  onChange={(event) =>
                    c.setScript((previous) =>
                      previous
                        ? {
                            ...previous,
                            segments: previous.segments.map((item) =>
                              item.id === segment.id ? { ...item, text: event.target.value } : item,
                            ),
                          }
                        : null,
                    )
                  }
                />
              </label>
              <label>
                Duration (seconds)
                <input
                  ref={index === 0 ? timingInputRef : undefined}
                  aria-label={`Seconds for script moment ${index + 1}`}
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={segment.seconds}
                  onChange={(event) =>
                    c.setScript((previous) =>
                      previous
                        ? {
                            ...previous,
                            segments: previous.segments.map((item) =>
                              item.id === segment.id
                                ? { ...item, seconds: Number(event.target.value) }
                                : item,
                            ),
                          }
                        : null,
                    )
                  }
                />
              </label>
              {hasNext && (
                <>
                  <button
                    type="button"
                    className="creator-text-button"
                    disabled={!combination.segments}
                    aria-label={`Combine moment ${index + 1} with moment ${index + 2}`}
                    aria-describedby={
                      combination.reason ? `creator-combine-reason-${segment.id}` : undefined
                    }
                    onClick={() =>
                      c.setScript((previous) => {
                        if (!previous) return previous;
                        const next = combineScriptMoments(previous.segments, index);
                        return next.segments ? { ...previous, segments: next.segments } : previous;
                      })
                    }
                  >
                    Combine with next moment
                  </button>
                  {combination.reason && (
                    <p className="creator-fineprint" id={`creator-combine-reason-${segment.id}`}>
                      {combination.reason}
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })}
      </fieldset>
      <button
        className="creator-primary-button"
        disabled={disabled || !c.scriptDirty || c.planDirty || c.inputDirty}
        onClick={c.saveScript}
      >
        Save script <Check size={16} />
      </button>
      <p className="creator-fineprint">
        Combining keeps both texts and adds their durations. Adjust timing to keep your chosen film
        length, save, then prepare again to rebuild the shot plan.
      </p>
    </div>
  );
}

function JobPanel({ c, job }: { c: CreatorController; job: CreatorJob }) {
  const current = c.state && outputIsCurrent(job, c.state.session, c.state.workflow);
  const caption = current ? (c.state?.session.plan?.caption ?? '') : '';
  const captionInput = useRef<HTMLTextAreaElement>(null);
  const [captionFeedback, setCaptionFeedback] = useState('');
  const downloadController = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadFeedback, setDownloadFeedback] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [playbackError, setPlaybackError] = useState(false);
  const [playbackRetry, setPlaybackRetry] = useState(0);
  useEffect(() => setCaptionFeedback(''), [job.id, caption]);
  useEffect(() => {
    setDownloading(false);
    setDownloadFeedback('');
    setDownloadError('');
    setPlaybackError(false);
    return () => {
      downloadController.current?.abort();
      downloadController.current = null;
    };
  }, [job.id, current]);
  function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    try {
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  async function downloadFilm() {
    const output = job.output;
    if (!current || !output || downloadController.current) return;
    const active = new AbortController();
    downloadController.current = active;
    setDownloading(true);
    setDownloadError('');
    setDownloadFeedback('Checking the completed film before download.');
    try {
      const blob = await fetchCreatorVideo(
        creatorApi.outputUrl(job.sessionId, job.id, true),
        output,
        active.signal,
      );
      if (active.signal.aborted || downloadController.current !== active) return;
      saveBlob(blob, 'yap-film.mp4');
      setDownloadFeedback('Film download requested.');
    } catch (error) {
      if (downloadController.current !== active) return;
      if (active.signal.aborted)
        setDownloadFeedback('Film download canceled. You can request it again.');
      else {
        setDownloadFeedback('');
        setDownloadError(
          error instanceof Error
            ? error.message
            : 'The film could not be downloaded. Retry or reload the saved studio.',
        );
      }
    } finally {
      if (downloadController.current === active) {
        downloadController.current = null;
        setDownloading(false);
      }
    }
  }
  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(caption);
      setCaptionFeedback('Caption copied.');
    } catch {
      captionInput.current?.focus();
      captionInput.current?.select();
      setCaptionFeedback(
        'Clipboard access is unavailable. The caption is selected; use your keyboard to copy it.',
      );
    }
  }
  function downloadCaption() {
    try {
      saveBlob(new Blob([caption], { type: 'text/plain;charset=utf-8' }), 'yap-caption.txt');
      setCaptionFeedback('Caption download requested.');
    } catch {
      captionInput.current?.focus();
      captionInput.current?.select();
      setCaptionFeedback(
        'The caption could not be downloaded. The text is selected so you can copy it.',
      );
    }
  }
  const latest = new Map<string, CreatorJob['clips'][number]>();
  job.clips.forEach((receipt) => {
    const old = latest.get(receipt.clipId);
    if (!old || receipt.attempt >= old.attempt) latest.set(receipt.clipId, receipt);
  });
  const title =
    job.status === 'succeeded'
      ? job.kind === 'analysis'
        ? 'The research is in.'
        : current
          ? 'Your next first showing.'
          : 'An earlier film.'
      : job.status === 'failed'
        ? 'This run needs a closer look.'
        : job.status === 'canceled'
          ? 'Remaining work was canceled.'
          : job.kind === 'analysis'
            ? 'Finding the useful details.'
            : 'Your approved film is in production.';
  return (
    <section className="creator-job" aria-labelledby="creator-job-title">
      <div className="creator-section-title">
        <div>
          <span className="creator-kicker">Actual job activity</span>
          <h2 id="creator-job-title">{title}</h2>
          <p>
            {job.status} / {job.phase}
            {c.watching ? ' / receiving status updates' : ''}
          </p>
        </div>
        {isActiveJob(job) && (
          <div className="creator-actions">
            {c.watching ? (
              <button className="creator-text-button" onClick={c.stopWatching}>
                Pause updates
              </button>
            ) : (
              <button className="creator-secondary-button" onClick={c.reconnect}>
                Reconnect
              </button>
            )}
            <button
              className="creator-secondary-button"
              disabled={Boolean(c.busy)}
              onClick={c.cancel}
            >
              <Stop size={15} /> Cancel remaining work
            </button>
          </div>
        )}
      </div>
      {job.error && (
        <div className="creator-inline-error" role="alert">
          <strong>{job.error.code}</strong>
          <p>{job.error.message}</p>
          <p>
            Review the sources and plan before retrying. No replacement run starts automatically.
          </p>
        </div>
      )}
      {isActiveJob(job) && job.kind === 'production' && (
        <p className="creator-fineprint">
          Cancellation prevents further requests where possible. In flight provider work can still
          finish and be billed.
        </p>
      )}
      {!!job.events.length && (
        <ol className="creator-job-events">
          {job.events.slice(-6).map((event, index) => (
            <li key={`${event.at}-${index}`}>
              <time dateTime={event.at}>
                {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
              <span>{event.message}</span>
            </li>
          ))}
        </ol>
      )}
      {!!latest.size && (
        <div className="creator-clip-receipts">
          {[...latest.values()].map((receipt, index) => (
            <article key={receipt.clipId}>
              <div>
                <strong>Shot {index + 1}</strong>
                <span>
                  {receipt.status} / attempt {receipt.attempt} of 2
                </span>
              </div>
              {receipt.audit && (
                <>
                  <p>{receipt.audit.summary}</p>
                  <small>
                    Technical check: {receipt.audit.technicalPassed ? 'passed' : 'needs a fix'} /
                    Visual check:{' '}
                    {receipt.audit.visionPassed === null
                      ? 'not completed'
                      : receipt.audit.visionPassed
                        ? 'passed'
                        : 'needs a fix'}
                  </small>
                  {!!receipt.audit.issues.length && (
                    <ul>
                      {receipt.audit.issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {receipt.status === 'passed' && (
                <details>
                  <summary>Watch this audited clip</summary>
                  <video
                    controls
                    playsInline
                    preload="none"
                    src={creatorApi.clipUrl(job.sessionId, job.id, receipt.clipId, receipt.attempt)}
                    aria-label={`Audited clip ${index + 1}`}
                  />
                </details>
              )}
            </article>
          ))}
        </div>
      )}
      {job.status === 'succeeded' && job.output && !current && (
        <div className="creator-inline-error">
          <p id="creator-earlier-export-reason">
            This completed job belongs to an earlier version. Its receipt and clip audits remain
            visible. Film downloads require the current approved version; prepare and approve the
            current plan before producing a new film.
          </p>
          <button
            className="creator-primary-button"
            disabled
            aria-describedby="creator-earlier-export-reason"
          >
            <DownloadSimple size={18} /> Download film
          </button>
        </div>
      )}
      {job.status === 'succeeded' && job.output && current && (
        <div className="creator-output">
          <div>
            <video
              key={`${job.id}-${playbackRetry}`}
              src={creatorApi.outputUrl(job.sessionId, job.id)}
              controls
              playsInline
              preload="metadata"
              aria-label={current ? 'Completed generated film' : 'Earlier generated film'}
              onError={() => setPlaybackError(true)}
            />
            {playbackError && (
              <div className="creator-inline-error" role="alert">
                <p>
                  The film preview could not load. Retry the preview or reload the saved studio to
                  check whether the export is current.
                </p>
                <button
                  className="creator-text-button"
                  onClick={() => {
                    setPlaybackError(false);
                    setPlaybackRetry((value) => value + 1);
                  }}
                >
                  Retry film preview
                </button>
              </div>
            )}
            <span>
              {job.output.width} × {job.output.height} / {job.output.duration}s /{' '}
              {job.output.hasAudio ? 'With sound' : 'Silent'}
            </span>
          </div>
          <div>
            <h3>
              {current
                ? 'Ready for your own screen.'
                : 'This export belongs to an earlier version.'}
            </h3>
            <p>
              {current
                ? 'Watch the whole film. Take the file and caption to the platform you choose.'
                : 'Your current edits and approvals are kept separate from this completed export.'}
            </p>
            <button
              type="button"
              className="creator-primary-button"
              onClick={() => void downloadFilm()}
              disabled={!current || downloading || Boolean(c.busy)}
            >
              <DownloadSimple size={18} />{' '}
              {downloading
                ? 'Checking film download'
                : downloadError
                  ? 'Retry film download'
                  : 'Download film'}
            </button>
            {downloading && (
              <button
                className="creator-text-button"
                onClick={() => downloadController.current?.abort()}
              >
                Cancel download
              </button>
            )}
            {downloadFeedback && (
              <p className="creator-caption-feedback" role="status">
                {downloadFeedback}
              </p>
            )}
            {downloadError && (
              <div className="creator-inline-error" role="alert">
                <p>{downloadError}</p>
                <button className="creator-text-button" onClick={c.reload}>
                  Reload saved studio
                </button>
              </div>
            )}
            {current && c.state?.session.plan && (
              <>
                <label>
                  Post caption
                  <textarea
                    ref={captionInput}
                    readOnly
                    value={caption}
                    rows={6}
                    placeholder="No caption saved for this film."
                  />
                </label>
                <div className="creator-caption-actions">
                  <button
                    type="button"
                    className="creator-secondary-button"
                    onClick={() => void copyCaption()}
                    disabled={!caption.trim()}
                  >
                    <Copy size={16} /> Copy caption
                  </button>
                  <button
                    type="button"
                    className="creator-secondary-button"
                    onClick={downloadCaption}
                    disabled={!caption.trim()}
                  >
                    <DownloadSimple size={16} /> Download caption
                  </button>
                </div>
                {!caption.trim() && (
                  <p className="creator-fineprint">
                    No caption was saved with this film. Edit the post caption in the shot plan to
                    add one for the next version.
                  </p>
                )}
                {captionFeedback && (
                  <p className="creator-caption-feedback" role="status">
                    {captionFeedback}
                  </p>
                )}
              </>
            )}
            <p className="creator-fineprint">Nothing has been posted to a social account.</p>
          </div>
        </div>
      )}
      {job.status === 'failed' && job.kind === 'analysis' && (
        <button
          className="creator-secondary-button"
          disabled={Boolean(c.busy) || c.dirty}
          onClick={c.analyze}
        >
          Retry research <ArrowsClockwise size={16} />
        </button>
      )}
    </section>
  );
}

function SoundControls({ c, disabled }: { c: CreatorController; disabled: boolean }) {
  const audio = c.plan?.audio;
  const tracks = c.capabilities?.musicTracks ?? [];
  const voices = c.capabilities?.voices ?? [];
  if (!audio || !c.capabilities) return null;
  const track = tracks.find((item) => item.id === audio.musicTrackId);
  return (
    <fieldset className="creator-sound-controls" disabled={disabled}>
      <legend>Sound for the whole film</legend>
      <label>
        Narration voice
        <select
          value={audio.voice ?? ''}
          disabled={voices.length === 0}
          onChange={(event) =>
            c.setPlan((previous) =>
              previous
                ? {
                    ...previous,
                    audio: {
                      ...previous.audio,
                      voice: (event.target.value || null) as typeof audio.voice,
                    },
                  }
                : null,
            )
          }
        >
          <option value="">No narration</option>
          {voices.map((voice) => (
            <option key={voice} value={voice}>
              {voice[0]!.toUpperCase() + voice.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <p className="creator-fineprint">
        {voices.length === 0
          ? 'Narration needs an OpenAI key on the server.'
          : 'An AI voice reads the script moments in time with their shots. It is priced in the quote.'}
      </p>
      <label>
        Background music
        <select
          value={audio.musicTrackId ?? ''}
          disabled={tracks.length === 0}
          onChange={(event) =>
            c.setPlan((previous) =>
              previous
                ? {
                    ...previous,
                    audio: { ...previous.audio, musicTrackId: event.target.value || null },
                  }
                : null,
            )
          }
        >
          <option value="">No music</option>
          {tracks.map((item) => (
            <option key={item.id} value={item.id}>
              {item.mood[0]!.toUpperCase() + item.mood.slice(1)}: {item.title}
            </option>
          ))}
        </select>
      </label>
      {track && (
        <>
          <p className="creator-fineprint">{track.description}</p>
          <audio
            key={track.id}
            className="creator-sound-preview"
            controls
            preload="none"
            src={creatorApi.musicUrl(track.id)}
            aria-label={`Preview ${track.title}`}
          />
        </>
      )}
      <p className="creator-fineprint">
        Bundled music is free and lowers itself while the voice speaks.
      </p>
    </fieldset>
  );
}
