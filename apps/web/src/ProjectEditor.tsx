import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle,
  Clock,
  Copy,
  DownloadSimple,
  FilmStrip,
  NotePencil,
  Plus,
  Quotes,
  Sparkle,
  Trash,
  X,
} from '@phosphor-icons/react';
import {
  createProjectSchema,
  draftContentSchema,
  type DraftContent,
  type Project,
  type ProjectBrief,
  type Shot,
} from '@yap/contracts';
import { api, ApiFailure, messageOf } from './api';
import {
  BriefFields,
  ErrorNotice,
  LoadingState,
  platformNames,
  Status,
  timeAgo,
  toneNames,
} from './components';

type Tab = 'script' | 'shots' | 'brief';
function briefOf(project: Project): ProjectBrief {
  return {
    title: project.title,
    idea: project.idea,
    audience: project.audience,
    platform: project.platform,
    duration: project.duration,
    tone: project.tone,
    goal: project.goal,
  };
}
function draftOf(project: Project): DraftContent | null {
  if (!project.draft) return null;
  const { provider: _provider, generatedAt: _generatedAt, ...content } = project.draft;
  return content;
}

export function ProjectEditor({
  id,
  onBack,
  onDirty,
  onUpdated,
  onDeleted,
}: {
  id: string;
  onBack(): void;
  onDirty(dirty: boolean): void;
  onUpdated(): void;
  onDeleted(): void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [brief, setBrief] = useState<ProjectBrief | null>(null);
  const [draft, setDraft] = useState<DraftContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('script');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'generate' | 'delete' | ''>('');

  const accept = useCallback(
    (value: Project) => {
      setProject(value);
      setBrief(briefOf(value));
      setDraft(draftOf(value));
      setFieldErrors({});
      onDirty(false);
    },
    [onDirty],
  );
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setNotFound(false);
    try {
      accept((await api.get(id)).project);
    } catch (caught) {
      setLoadError(messageOf(caught));
      setNotFound(caught instanceof ApiFailure && caught.status === 404);
    } finally {
      setLoading(false);
    }
  }, [id, accept]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const briefDirty = !!project && JSON.stringify(brief) !== JSON.stringify(briefOf(project));
  const draftDirty = !!project && JSON.stringify(draft) !== JSON.stringify(draftOf(project));
  const dirty = briefDirty || draftDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  async function saveBrief() {
    const parsed = createProjectSchema.safeParse(brief);
    if (!parsed.success) {
      setFieldErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
        ),
      );
      return;
    }
    setBusy('brief');
    setError('');
    try {
      accept((await api.update(id, { ...parsed.data, status: 'draft' })).project);
      onUpdated();
      setNotice('Brief saved. Your next draft will use these details.');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }
  async function saveDraft() {
    const parsed = draftContentSchema.safeParse(draft);
    if (!parsed.success) {
      setError(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' '),
      );
      return;
    }
    if (parsed.data.shots.reduce((sum, shot) => sum + shot.seconds, 0) !== project?.duration) {
      setError(
        `Your shot lengths should add up to ${project?.duration} seconds. Adjust the seconds in your shot plan, then save.`,
      );
      setTab('shots');
      return;
    }
    setBusy('draft');
    setError('');
    try {
      accept((await api.update(id, { draft: parsed.data, status: 'draft' })).project);
      onUpdated();
      setNotice('Script and shot plan saved.');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }
  async function generate() {
    setConfirm('');
    setBusy('generate');
    setError('');
    try {
      accept((await api.generate(id)).project);
      onUpdated();
      setTab('script');
      setNotice('Your guided draft is ready to edit. Make it sound like you.');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }
  async function toggleReady() {
    if (!project) return;
    setBusy('status');
    setError('');
    try {
      const next = project.status === 'ready' ? 'draft' : 'ready';
      accept((await api.update(id, { status: next })).project);
      onUpdated();
      setNotice(
        next === 'ready'
          ? 'Marked ready to film. You’ve got a plan.'
          : 'Project moved back to drafts.',
      );
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }
  async function remove() {
    setBusy('delete');
    setError('');
    try {
      await api.remove(id);
      onDirty(false);
      onDeleted();
    } catch (caught) {
      setError(messageOf(caught));
      setConfirm('');
    } finally {
      setBusy('');
    }
  }
  async function download(format: 'markdown' | 'json') {
    if (!project?.draft || dirty || busy) return;
    setBusy('download');
    setError('');
    try {
      await api.download(id, project.title, format);
      setNotice('Your project has been downloaded.');
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy('');
    }
  }
  async function copy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.script);
      setNotice('Script copied to clipboard.');
    } catch {
      setError(
        'The browser could not copy the script. Select the script text and copy it manually.',
      );
    }
  }
  const updateShot = (index: number, changes: Partial<Shot>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            shots: current.shots.map((shot, i) => (i === index ? { ...shot, ...changes } : shot)),
          }
        : current,
    );
  function moveShot(index: number, direction: -1 | 1) {
    if (!draft || index + direction < 0 || index + direction >= draft.shots.length) return;
    const shots = [...draft.shots];
    [shots[index], shots[index + direction]] = [shots[index + direction]!, shots[index]!];
    setDraft({ ...draft, shots });
  }

  if (loading) return <LoadingState label="Opening your project" />;
  if (loadError || !project || !brief)
    return (
      <>
        <button className="text-button back-button" onClick={onBack}>
          <ArrowLeft size={16} />
          All projects
        </button>
        <div className="not-found">
          <FilmStrip size={40} weight="light" />
          <h1>{notFound ? 'This project isn’t here.' : 'Let’s reconnect your studio.'}</h1>
          <p>
            {notFound
              ? 'It may have been deleted. Your other ideas are waiting in the workspace.'
              : loadError}
          </p>
          {!notFound && (
            <button className="button button-primary" onClick={() => void load()}>
              Try again <ArrowRight size={18} />
            </button>
          )}
        </div>
      </>
    );
  const totalSeconds = draft?.shots.reduce((sum, shot) => sum + shot.seconds, 0) ?? 0;
  const words = draft?.script.trim().split(/\s+/).filter(Boolean).length ?? 0;
  let elapsed = 0;

  return (
    <>
      <button className="text-button back-button" onClick={onBack}>
        <ArrowLeft size={16} />
        All projects
      </button>
      <div className="editor-heading">
        <div>
          <div className="editor-eyebrow">
            <span className="eyebrow">Your studio</span>
            <Status status={project.status} />
          </div>
          <h1>{project.title}</h1>
          <p>
            {platformNames[project.platform]}
            <span>·</span>
            {project.duration} seconds<span>·</span>Saved {timeAgo(project.updatedAt).toLowerCase()}
          </p>
        </div>
        <div className="editor-heading-actions">
          <button
            className="button button-secondary"
            onClick={() => void toggleReady()}
            disabled={!!busy || !project.draft || dirty}
            title={
              dirty
                ? 'Save your changes first'
                : !project.draft
                  ? 'Create a draft first'
                  : undefined
            }
          >
            <CheckCircle size={18} />
            {busy === 'status'
              ? 'Saving…'
              : project.status === 'ready'
                ? 'Move to draft'
                : 'Mark ready to film'}
          </button>
          <details className="export-menu">
            <summary
              className={`button button-primary ${!project.draft || dirty || busy ? 'disabled' : ''}`}
              aria-disabled={!project.draft || dirty || !!busy}
              onClick={(event) => {
                if (!project.draft || dirty || busy) event.preventDefault();
              }}
            >
              <DownloadSimple size={18} />
              Export
            </summary>
            <div className="export-options">
              <button
                disabled={!project.draft || dirty || !!busy}
                onClick={() => void download('markdown')}
              >
                Download Markdown <span>.md</span>
              </button>
              <button
                disabled={!project.draft || dirty || !!busy}
                onClick={() => void download('json')}
              >
                Download project data <span>.json</span>
              </button>
            </div>
          </details>
        </div>
      </div>
      {notice && (
        <div className="notice notice-success" role="status">
          <Check size={20} />
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss confirmation"
            onClick={() => setNotice('')}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {error && <ErrorNotice message={error} onDismiss={() => setError('')} />}
      {confirm === 'generate' && (
        <div className="notice confirmation-notice" role="alert">
          <span>
            A new guided draft replaces your current script and shot plan, including edits.
          </span>
          <button className="text-button" onClick={() => setConfirm('')}>
            Keep current draft
          </button>
          <button className="button button-primary" onClick={() => void generate()}>
            Replace draft
          </button>
        </div>
      )}
      {confirm === 'delete' && (
        <div className="notice confirmation-notice" role="alert">
          <span>Delete “{project.title}”? Its brief, script, and shot plan will be removed.</span>
          <button className="text-button" onClick={() => setConfirm('')}>
            Keep project
          </button>
          <button className="button button-danger" disabled={!!busy} onClick={() => void remove()}>
            {busy === 'delete' ? 'Deleting…' : 'Delete project'}
          </button>
        </div>
      )}
      <div className="editor-layout">
        <div className="editor-main">
          <div className="editor-tabs" role="tablist" aria-label="Project sections">
            {(
              [
                { key: 'script', label: 'Script', Icon: Quotes },
                { key: 'shots', label: 'Shot plan', Icon: FilmStrip },
                { key: 'brief', label: 'The brief', Icon: NotePencil },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                id={`tab-${key}`}
                role="tab"
                aria-selected={tab === key}
                aria-controls={`panel-${key}`}
                onClick={() => setTab(key)}
                className={tab === key ? 'active' : ''}
              >
                <Icon size={20} />
                {label}
                {key === 'shots' && draft && (
                  <span className="tab-count">{draft.shots.length}</span>
                )}
              </button>
            ))}
          </div>
          <section
            className="editor-panel"
            id={`panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
          >
            {tab === 'brief' ? (
              <>
                <div className="panel-heading">
                  <div>
                    <h2>The thought behind the video</h2>
                    <p>A clear brief keeps every word and shot on track.</p>
                  </div>
                </div>
                {briefDirty && project.draft && (
                  <div className="notice notice-neutral">
                    Saving a changed brief clears the current draft so your next script matches the
                    new direction.
                  </div>
                )}
                <BriefFields
                  value={brief}
                  onChange={(value) => {
                    setBrief(value);
                    setFieldErrors({});
                  }}
                  errors={fieldErrors}
                  disabled={!!busy}
                />
                <div className="editor-save-bar">
                  <span>{briefDirty ? 'Unsaved brief changes' : 'Your brief is saved'}</span>
                  <button
                    className="button button-primary"
                    onClick={() => void saveBrief()}
                    disabled={!!busy || !briefDirty}
                  >
                    {busy === 'brief' ? 'Saving…' : 'Save brief'}
                    <Check size={18} />
                  </button>
                </div>
              </>
            ) : !draft ? (
              <div className="draft-empty">
                <div className="empty-icon">
                  <Quotes size={32} weight="light" />
                </div>
                <span className="eyebrow">Your idea has a home. Give it a voice.</span>
                <h2>Meet your first draft.</h2>
                <p>
                  Turn your saved brief into a script and a timed shot plan. Then edit every line
                  until it sounds like you.
                </p>
                <button
                  className="button button-primary"
                  disabled={!!busy || briefDirty}
                  onClick={() => void generate()}
                >
                  <Sparkle size={18} />
                  {busy === 'generate' ? 'Creating your draft…' : 'Create guided draft'}
                </button>
                <span className="field-hint">
                  A structured starting point. Your creativity takes it from here.
                </span>
                {busy === 'generate' && (
                  <div className="generation-skeleton" aria-label="Creating draft" role="status">
                    <div className="skeleton" />
                    <div className="skeleton" />
                    <div className="skeleton" />
                  </div>
                )}
              </div>
            ) : tab === 'script' ? (
              <>
                <div className="panel-heading">
                  <div>
                    <h2>Make it sound like you.</h2>
                    <p>Keep what works. Rewrite what doesn’t.</p>
                  </div>
                  <button className="text-button" onClick={() => void copy()}>
                    <Copy size={18} />
                    Copy script
                  </button>
                </div>
                <fieldset className="script-fields" disabled={!!busy}>
                  <div className="field hook-field">
                    <label htmlFor="hook">
                      <span className="small-label">THE FIRST FEW SECONDS</span>Your hook
                    </label>
                    <textarea
                      id="hook"
                      value={draft.hook}
                      maxLength={1000}
                      onChange={(e) => setDraft({ ...draft, hook: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <div className="field-label">
                      <label htmlFor="script">The script</label>
                      <span>{words} words</span>
                    </div>
                    <textarea
                      id="script"
                      className="script-input"
                      value={draft.script}
                      maxLength={10000}
                      onChange={(e) => setDraft({ ...draft, script: e.target.value })}
                    />
                    <span className="field-hint">
                      Read it out loud. Your natural pace matters more than a word count.
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="caption">Post caption</label>
                    <textarea
                      id="caption"
                      value={draft.caption}
                      maxLength={3000}
                      onChange={(e) => setDraft({ ...draft, caption: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="hashtags">Hashtags</label>
                    <input
                      id="hashtags"
                      value={draft.hashtags.join(' ')}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          hashtags: e.target.value.split(/\s+/).filter(Boolean),
                        })
                      }
                    />
                    <span className="field-hint">
                      Separate each hashtag with a space. Up to 20.
                    </span>
                  </div>
                </fieldset>
                <div className="editor-save-bar">
                  <span>{draftDirty ? 'Unsaved script changes' : 'Your script is saved'}</span>
                  <button
                    className="button button-primary"
                    disabled={!!busy || !draftDirty || briefDirty}
                    onClick={() => void saveDraft()}
                  >
                    {busy === 'draft' ? 'Saving…' : 'Save changes'}
                    <Check size={18} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="panel-heading">
                  <div>
                    <h2>Picture the whole story.</h2>
                    <p>What you see, what you say, and when it happens.</p>
                  </div>
                  <span
                    className={`duration-total ${totalSeconds !== project.duration ? 'duration-warning' : ''}`}
                  >
                    <Clock size={16} />
                    {totalSeconds} / {project.duration}s
                  </span>
                </div>
                <div className="shot-timeline" aria-label="Shot timing">
                  {draft.shots.map((shot, index) => {
                    const start = elapsed;
                    elapsed += shot.seconds;
                    return (
                      <a
                        key={shot.id}
                        href={`#shot-${shot.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          document.getElementById(`shot-${shot.id}`)?.scrollIntoView({
                            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                              ? 'instant'
                              : 'smooth',
                            block: 'center',
                          });
                        }}
                        style={{ flexGrow: Math.max(1, shot.seconds) }}
                      >
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <strong>
                          {start}s – {elapsed}s
                        </strong>
                      </a>
                    );
                  })}
                </div>
                <div className="shot-list">
                  {draft.shots.map((shot, index) => (
                    <article className="shot-editor" key={shot.id} id={`shot-${shot.id}`}>
                      <div className="shot-heading">
                        <div>
                          <span className="shot-number">{String(index + 1).padStart(2, '0')}</span>
                          <h3>Shot {index + 1}</h3>
                        </div>
                        <div className="shot-controls">
                          <button
                            className="icon-button"
                            aria-label={`Move shot ${index + 1} earlier`}
                            disabled={!!busy || index === 0}
                            onClick={() => moveShot(index, -1)}
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Move shot ${index + 1} later`}
                            disabled={!!busy || index === draft.shots.length - 1}
                            onClick={() => moveShot(index, 1)}
                          >
                            <ArrowDown size={16} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Remove shot ${index + 1}`}
                            disabled={!!busy || draft.shots.length <= 1}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                shots: draft.shots.filter((_, i) => i !== index),
                              })
                            }
                          >
                            <Trash size={16} />
                          </button>
                        </div>
                      </div>
                      <fieldset disabled={!!busy}>
                        <div className="shot-fields">
                          <div className="field">
                            <label htmlFor={`visual-${shot.id}`}>What we see</label>
                            <textarea
                              id={`visual-${shot.id}`}
                              value={shot.visual}
                              maxLength={1000}
                              onChange={(e) => updateShot(index, { visual: e.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`voice-${shot.id}`}>What you say</label>
                            <textarea
                              id={`voice-${shot.id}`}
                              value={shot.voiceover}
                              maxLength={2000}
                              onChange={(e) => updateShot(index, { voiceover: e.target.value })}
                            />
                          </div>
                        </div>
                        <div className="shot-bottom-fields">
                          <div className="field">
                            <label htmlFor={`screen-${shot.id}`}>Text on screen</label>
                            <input
                              id={`screen-${shot.id}`}
                              value={shot.onScreenText}
                              maxLength={300}
                              onChange={(e) => updateShot(index, { onScreenText: e.target.value })}
                            />
                          </div>
                          <div className="field shot-duration">
                            <label htmlFor={`seconds-${shot.id}`}>Seconds</label>
                            <input
                              id={`seconds-${shot.id}`}
                              type="number"
                              min={1}
                              max={60}
                              value={shot.seconds}
                              onChange={(e) =>
                                updateShot(index, { seconds: Number(e.target.value) })
                              }
                            />
                          </div>
                        </div>
                      </fieldset>
                    </article>
                  ))}
                </div>
                <button
                  className="button button-secondary add-shot"
                  disabled={!!busy || draft.shots.length >= 12}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      shots: [
                        ...draft.shots,
                        {
                          id: crypto.randomUUID(),
                          seconds: 3,
                          visual: 'Describe what to film.',
                          voiceover: 'Write the words for this shot.',
                          onScreenText: '',
                        },
                      ],
                    })
                  }
                >
                  <Plus size={18} />
                  Add a shot
                </button>
                <div className="editor-save-bar">
                  <span>
                    {draftDirty ? 'Unsaved shot plan changes' : 'Your shot plan is saved'}
                  </span>
                  <button
                    className="button button-primary"
                    disabled={!!busy || !draftDirty || briefDirty}
                    onClick={() => void saveDraft()}
                  >
                    {busy === 'draft' ? 'Saving…' : 'Save changes'}
                    <Check size={18} />
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
        <aside className="project-overview">
          <div className="overview-icon">
            <FilmStrip size={24} weight="light" />
          </div>
          <span className="eyebrow">THE DIRECTION</span>
          <h2>
            One idea.
            <br />
            Your point of view.
          </h2>
          <p className="overview-idea">{project.idea}</p>
          <dl>
            <div>
              <dt>Made for</dt>
              <dd>{project.audience}</dd>
            </div>
            <div>
              <dt>The feeling</dt>
              <dd>{toneNames[project.tone]}</dd>
            </div>
            <div>
              <dt>The format</dt>
              <dd>
                {platformNames[project.platform]} · {project.duration}s
              </dd>
            </div>
          </dl>
          <div className="readiness-list">
            <div>
              <CheckCircle size={18} weight="fill" className="check-complete" />
              <span>Idea saved</span>
            </div>
            <div>
              <CheckCircle
                size={18}
                weight={project.draft ? 'fill' : 'regular'}
                className={project.draft ? 'check-complete' : ''}
              />
              <span>Script and shots planned</span>
            </div>
            <div>
              <CheckCircle
                size={18}
                weight={project.status === 'ready' ? 'fill' : 'regular'}
                className={project.status === 'ready' ? 'check-complete' : ''}
              />
              <span>Ready for the camera</span>
            </div>
          </div>
          {project.draft && (
            <button
              className="text-button regenerate-button"
              disabled={!!busy || briefDirty}
              onClick={() => setConfirm('generate')}
            >
              <Sparkle size={18} />
              {busy === 'generate' ? 'Creating draft…' : 'Create a fresh draft'}
            </button>
          )}
          {dirty && (
            <p className="field-hint save-reminder">
              Save your changes before exporting or marking this project ready.
            </p>
          )}
          <p className="guided-note">
            Guided drafts are a starting point. Check the details and add your own voice.
          </p>
          <button
            className="text-button delete-project"
            disabled={!!busy}
            onClick={() => setConfirm('delete')}
          >
            <Trash size={16} />
            Delete project
          </button>
        </aside>
      </div>
    </>
  );
}
