import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookmarkSimple,
  Check,
  ChatCircleText,
  Clock,
  Graph,
  Lightbulb,
  List,
  MagnifyingGlass,
  NotePencil,
  Plus,
  Trash,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import {
  socialDatasetSchema,
  type SocialGraphNode,
  type SocialHandoff,
  type SocialInsight,
  type SocialInvestigation,
  type SocialInvestigationSummary,
  type SocialNote,
  type SocialNoteInput,
  type SocialPlatform,
  type SocialPost,
  type SocialProviderStatus,
  type SocialQueryResponse,
} from '@yap/contracts/social';
import ResearchGraph from './Graph';
import { researchError, socialApi } from './api';
import './social.css';

const platformNames: Record<SocialPlatform, string> = {
  x: 'X',
  instagram: 'Instagram',
  web: 'Public web',
};
const noteKinds: SocialNoteInput['kind'][] = ['adopt', 'avoid', 'test', 'context'];
const formatNumber = (number: number | null) =>
  number === null
    ? 'Unknown'
    : new Intl.NumberFormat(undefined, {
        notation: number >= 10000 ? 'compact' : 'standard',
        maximumFractionDigits: 1,
      }).format(number);
const formatDate = (date: string | null) =>
  date
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date).toLocaleDateString(
        undefined,
        { month: 'short', day: 'numeric' },
      )
    : 'Date unknown';
const snippet = (text: string, length = 180) =>
  text.length > length ? `${text.slice(0, length).trim()}…` : text;

export interface SocialWorkspaceProps {
  onUseResearch?: (
    handoff: SocialHandoff,
    investigation: SocialInvestigation,
  ) => Promise<void> | void;
  onDirty?: (dirty: boolean) => void;
}

export default function SocialWorkspace({ onUseResearch, onDirty }: SocialWorkspaceProps) {
  const [investigations, setInvestigations] = useState<SocialInvestigationSummary[]>([]);
  const [providers, setProviders] = useState<SocialProviderStatus[]>([]);
  const [active, setActive] = useState<SocialInvestigation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [newResearch, setNewResearch] = useState(false);
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [platforms, setPlatforms] = useState<SocialPlatform[]>(['x', 'instagram', 'web']);
  const [days, setDays] = useState(7);
  const [limit, setLimit] = useState(60);
  const [importJson, setImportJson] = useState('');
  const [publicOnly, setPublicOnly] = useState(false);
  const [view, setView] = useState<'graph' | 'list'>(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 600px)').matches
      ? 'list'
      : 'graph',
  );
  const [platformFilter, setPlatformFilter] = useState<SocialPlatform | 'all'>('all');
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [selectedNode, setSelectedNode] = useState('');
  const [selectedPostId, setSelectedPostId] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteKind, setNoteKind] = useState<SocialNoteInput['kind']>('adopt');
  const [noteEvidenceIds, setNoteEvidenceIds] = useState<string[]>([]);
  const [editingNote, setEditingNote] = useState('');
  const [selectedNotes, setSelectedNotes] = useState<string[]>([]);
  const [selectedInsights, setSelectedInsights] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<SocialQueryResponse | null>(null);
  const [handoff, setHandoff] = useState<SocialHandoff | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [used, setUsed] = useState(false);
  const [pendingChange, setPendingChange] = useState<(() => void) | null>(null);
  const epoch = useRef(0);
  const noteEditor = useRef<HTMLTextAreaElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const originalNote = active?.notes.find((note) => note.id === editingNote);
  const noteDirty = originalNote
    ? noteText !== originalNote.text ||
      noteKind !== originalNote.kind ||
      JSON.stringify(noteEvidenceIds) !== JSON.stringify(originalNote.evidenceIds)
    : noteText.trim().length > 0;

  useEffect(() => {
    onDirty?.(noteDirty);
  }, [noteDirty, onDirty]);
  useEffect(
    () => () => {
      onDirty?.(false);
    },
    [onDirty],
  );

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const [library, integrations] = await Promise.all([
          socialApi.list(),
          socialApi.providers(),
        ]);
        if (!current) return;
        setInvestigations(library.investigations);
        setProviders(integrations.providers);
      } catch (caught) {
        if (current) setError(researchError(caught));
      } finally {
        if (current) setLoading(false);
      }
    }
    void load();
    return () => {
      current = false;
      epoch.current += 1;
    };
  }, []);

  function openInvestigation(investigation: SocialInvestigation, discard = false) {
    if (noteDirty && !discard) {
      setPendingChange(() => () => openInvestigation(investigation, true));
      return;
    }
    epoch.current += 1;
    setActive(investigation);
    setNewResearch(false);
    setSelectedNode('');
    setSelectedPostId('');
    setSearch('');
    setDateFilter('');
    setPlatformFilter('all');
    setSelectedNotes([]);
    setSelectedInsights([]);
    setAnswer(null);
    setHandoff(null);
    setUsed(false);
    setEditingNote('');
    setNoteText('');
    setNoteEvidenceIds([]);
    setConfirmDelete(false);
    setError('');
    setStatus('');
    setPendingChange(null);
  }
  function updateInvestigation(investigation: SocialInvestigation) {
    setActive(investigation);
    setInvestigations((previous) => [
      investigation,
      ...previous.filter((item) => item.id !== investigation.id),
    ]);
    setHandoff(null);
    setUsed(false);
  }
  async function openSavedInvestigation(id: string, discard = false) {
    if (busy) return;
    if (noteDirty && !discard) {
      setPendingChange(() => () => {
        void openSavedInvestigation(id, true);
      });
      return;
    }
    setBusy('open');
    setError('');
    const requestEpoch = epoch.current;
    try {
      const result = await socialApi.get(id);
      if (requestEpoch === epoch.current) openInvestigation(result.investigation, true);
    } catch (caught) {
      if (requestEpoch === epoch.current) setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  async function refreshSources() {
    if (busy) return;
    setBusy('refresh');
    setError('');
    try {
      const [library, integrations] = await Promise.all([socialApi.list(), socialApi.providers()]);
      setInvestigations(library.investigations);
      setProviders(integrations.providers);
      setStatus('Saved research and source availability refreshed.');
    } catch (caught) {
      setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  async function create(mode: 'demo' | 'live') {
    if (busy) return;
    if (mode === 'live' && (!topic.trim() || !platforms.length)) {
      setError('Enter a theme and choose at least one source.');
      return;
    }
    setBusy('collect');
    setError('');
    setStatus('');
    const requestEpoch = epoch.current;
    try {
      const result = await socialApi.create({
        topic: topic.trim() || 'Better coffee at home',
        audience: audience.trim(),
        platforms: platforms.length ? platforms : ['x', 'instagram', 'web'],
        days,
        limit,
        mode,
      });
      if (requestEpoch !== epoch.current) return;
      setInvestigations((previous) => [result.investigation, ...previous]);
      openInvestigation(result.investigation);
      setStatus(
        mode === 'demo'
          ? 'Example opened. All posts and metrics in this investigation are synthetic.'
          : 'Research saved. Explore the collected sample and its coverage.',
      );
    } catch (caught) {
      if (requestEpoch === epoch.current) setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  async function importEvidence() {
    if (busy) return;
    if (!topic.trim() || !platforms.length) {
      setError('Enter a theme and choose at least one source before importing.');
      return;
    }
    if (!publicOnly) {
      setError('Confirm that the imported dataset contains public evidence only.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(importJson);
    } catch {
      setError(
        'The dataset is not valid JSON. Paste an object with posts, actors, relationships, and warnings arrays.',
      );
      return;
    }
    const dataset = socialDatasetSchema.safeParse(parsed);
    if (!dataset.success) {
      setError(
        `Check the imported dataset: ${dataset.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join(' ')} All posts need public HTTPS URLs and explicit provenance.`,
      );
      return;
    }
    setBusy('import');
    setError('');
    const requestEpoch = epoch.current;
    try {
      const result = await socialApi.importDataset(
        { topic: topic.trim(), audience: audience.trim(), platforms, days, limit, mode: 'live' },
        dataset.data,
      );
      if (requestEpoch !== epoch.current) return;
      setInvestigations((previous) => [result.investigation, ...previous]);
      openInvestigation(result.investigation);
      setImportJson('');
      setPublicOnly(false);
      setStatus('Public evidence imported. Imported data has not been independently verified.');
    } catch (caught) {
      if (requestEpoch === epoch.current) setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  function selectPost(postId: string, discard = false) {
    if (!active) return;
    if (noteDirty && !discard) {
      setPendingChange(() => () => selectPost(postId, true));
      return;
    }
    setSearch('');
    setDateFilter('');
    setPlatformFilter('all');
    setSelectedPostId(postId);
    setSelectedNode(
      active.analysis.graph.nodes.find(
        (node) => node.kind === 'post' && node.evidenceIds.includes(postId),
      )?.id ?? '',
    );
    setNoteEvidenceIds([postId]);
    setEditingNote('');
    setNoteText('');
    setPendingChange(null);
    requestAnimationFrame(() => {
      inspector.current?.focus({ preventScroll: true });
      inspector.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    });
  }
  function selectGraphNode(node: SocialGraphNode, discard = false) {
    if (noteDirty && !discard) {
      setPendingChange(() => () => selectGraphNode(node, true));
      return;
    }
    setSelectedNode(node.id);
    setSelectedPostId(node.evidenceIds[0] ?? '');
    setNoteEvidenceIds(node.evidenceIds.slice(0, 100));
    setEditingNote('');
    setNoteText('');
    setPendingChange(null);
  }
  function editNote(note: SocialNote, discard = false) {
    if (noteDirty && !discard) {
      setPendingChange(() => () => editNote(note, true));
      return;
    }
    setEditingNote(note.id);
    setNoteText(note.text);
    setNoteKind(note.kind);
    setNoteEvidenceIds(note.evidenceIds);
    setSelectedPostId(note.evidenceIds[0] ?? '');
    setSelectedNode(
      active?.analysis.graph.nodes.find(
        (node) => node.kind === 'post' && node.evidenceIds.includes(note.evidenceIds[0] ?? ''),
      )?.id ?? '',
    );
    setPendingChange(null);
    noteEditor.current?.focus();
    noteEditor.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }
  async function saveNote(event: FormEvent) {
    event.preventDefault();
    if (!active || !noteText.trim() || busy) return;
    setBusy('note');
    setError('');
    const requestEpoch = epoch.current;
    try {
      const input = { text: noteText.trim(), kind: noteKind, evidenceIds: noteEvidenceIds };
      const result = editingNote
        ? await socialApi.updateNote(active.id, editingNote, input)
        : await socialApi.addNote(active.id, input);
      if (requestEpoch !== epoch.current) return;
      updateInvestigation(result.investigation);
      setNoteText('');
      setEditingNote('');
      setPendingChange(null);
      setStatus('Creative note saved with its evidence.');
    } catch (caught) {
      if (requestEpoch === epoch.current) setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  async function removeNote(note: SocialNote) {
    if (!active || busy) return;
    setBusy('note');
    setError('');
    const requestEpoch = epoch.current;
    try {
      const result = await socialApi.removeNote(active.id, note.id);
      if (requestEpoch !== epoch.current) return;
      updateInvestigation(result.investigation);
      setSelectedNotes((previous) => previous.filter((id) => id !== note.id));
      if (editingNote === note.id) {
        setEditingNote('');
        setNoteText('');
      }
      setStatus('Note removed.');
    } catch (caught) {
      if (requestEpoch === epoch.current) setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!active || !question.trim() || busy) return;
    setBusy('query');
    setError('');
    const requestEpoch = epoch.current;
    try {
      const result = await socialApi.query(active.id, question.trim());
      if (requestEpoch === epoch.current) setAnswer(result);
    } catch (caught) {
      if (requestEpoch === epoch.current) setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  async function prepareHandoff() {
    if (!active || busy || !(selectedNotes.length + selectedInsights.length)) return;
    setBusy('handoff');
    setError('');
    const requestEpoch = epoch.current;
    try {
      const result = await socialApi.handoff(active.id, {
        noteIds: selectedNotes,
        insightIds: selectedInsights,
      });
      if (requestEpoch === epoch.current) {
        setHandoff(result);
        setUsed(false);
      }
    } catch (caught) {
      if (requestEpoch === epoch.current) setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  async function useResearch() {
    if (!active || !handoff || !onUseResearch || busy) return;
    setBusy('apply');
    setError('');
    try {
      await onUseResearch(handoff, active);
      setUsed(true);
      setStatus('Research sent to creation. Your source references are included.');
    } catch (caught) {
      setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  async function deleteInvestigation() {
    if (!active || busy) return;
    setBusy('delete');
    setError('');
    try {
      await socialApi.remove(active.id);
      setInvestigations((previous) => previous.filter((item) => item.id !== active.id));
      setActive(null);
      setConfirmDelete(false);
      setStatus('Investigation and its local notes deleted.');
    } catch (caught) {
      setError(researchError(caught));
    } finally {
      setBusy('');
    }
  }
  const visiblePosts = useMemo(
    () =>
      active?.analysis.posts.filter(
        (post) =>
          (platformFilter === 'all' || post.platform === platformFilter) &&
          (!dateFilter || post.publishedAt?.startsWith(dateFilter)) &&
          (!search.trim() ||
            `${post.text} ${active.analysis.actors.find((actor) => actor.id === post.actorId)?.name ?? ''}`
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase())),
      ) ?? [],
    [active, platformFilter, dateFilter, search],
  );
  const visibleIds = useMemo(() => new Set(visiblePosts.map((post) => post.id)), [visiblePosts]);
  const graphNodes =
    active?.analysis.graph.nodes.filter(
      (node) =>
        (!search && platformFilter === 'all' && !dateFilter) ||
        node.evidenceIds.some((id) => visibleIds.has(id)),
    ) ?? [];
  const selectedPost = active?.analysis.posts.find((post) => post.id === selectedPostId);
  const selectedActor = active?.analysis.actors.find((actor) => actor.id === selectedPost?.actorId);
  const selectedRank = active?.analysis.rankedPosts.find((rank) => rank.postId === selectedPostId);
  const focusedNode = active?.analysis.graph.nodes.find((node) => node.id === selectedNode);
  const configured = providers.some(
    (provider) =>
      provider.configured && provider.platforms.some((platform) => platforms.includes(platform)),
  );
  function toggleSelection(id: string, kind: 'note' | 'insight') {
    if (busy) return;
    const set = kind === 'note' ? setSelectedNotes : setSelectedInsights;
    set((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );
    setHandoff(null);
    setUsed(false);
  }

  return (
    <div className="social-workspace">
      <header className="social-page-heading">
        <div>
          <div className="social-heading-symbol">
            <Graph size={20} />
            <span>Research studio</span>
          </div>
          <h1>Find your next angle.</h1>
          <p>Explore the conversation. See the connections. Make something with a point of view.</p>
        </div>
        <div className="social-heading-actions">
          {!!investigations.length && (
            <label className="social-library-select">
              <span className="social-sr-only">Open saved research</span>
              <select
                aria-label="Open saved research"
                disabled={!!busy}
                value={active?.id ?? ''}
                onChange={(event) => {
                  const item = investigations.find(
                    (investigation) => investigation.id === event.target.value,
                  );
                  if (item) void openSavedInvestigation(item.id);
                }}
              >
                <option value="">Saved research ({investigations.length})</option>
                {investigations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.mode === 'demo' ? 'Example · ' : ''}
                    {item.topic}
                  </option>
                ))}
              </select>
            </label>
          )}
          {active && (
            <button
              className="social-button social-button-secondary"
              type="button"
              disabled={!!busy}
              onClick={() => setNewResearch((value) => !value)}
            >
              <Plus size={18} />
              New research
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="social-notice social-notice-error" role="alert">
          <WarningCircle size={20} />
          <span>{error}</span>
          <button
            type="button"
            className="social-text-button"
            disabled={!!busy}
            onClick={() => void refreshSources()}
          >
            Refresh sources
          </button>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss research error">
            <X size={18} />
          </button>
        </div>
      )}
      <p className={`social-status ${status ? '' : 'social-sr-only'}`} role="status">
        {status}
      </p>
      {pendingChange && (
        <div className="social-notice social-unsaved-notice" role="alert">
          <NotePencil size={20} />
          <span>
            Your note has unsaved changes. Keep editing or discard them before changing evidence.
          </span>
          <button
            type="button"
            className="social-text-button"
            onClick={() => setPendingChange(null)}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="social-button social-button-secondary"
            onClick={() => {
              const change = pendingChange;
              setPendingChange(null);
              change();
            }}
          >
            Discard note changes
          </button>
        </div>
      )}

      {loading ? (
        <div className="social-loading" role="status" aria-label="Loading research">
          <div />
          <div />
          <div />
          <span className="social-sr-only">Loading saved research and provider availability.</span>
        </div>
      ) : (
        <>
          {(!active || newResearch) && (
            <section className="social-start" aria-labelledby="social-start-title">
              <div className="social-start-copy">
                <span className="social-section-icon">
                  <MagnifyingGlass size={24} />
                </span>
                <h2 id="social-start-title">What are you exploring?</h2>
                <p>
                  Start with a field, a question, or a creative idea. Your research board brings
                  public examples and the people behind them into one view.
                </p>
                <button
                  type="button"
                  className="social-text-button"
                  disabled={!!busy}
                  onClick={() => void create('demo')}
                >
                  {busy === 'collect' ? 'Preparing research…' : 'Explore the coffee example'}
                  <ArrowRight size={18} />
                </button>
                <span className="social-caption">
                  Example posts are synthetic and clearly labeled.
                </span>
              </div>
              <form
                className="social-research-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create('live');
                }}
              >
                <label>
                  Theme or idea
                  <input
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    maxLength={300}
                    required
                    placeholder="How are coffee brands teaching home espresso?"
                    disabled={!!busy}
                  />
                </label>
                <label>
                  Who are you creating for? <span className="social-optional">Optional</span>
                  <input
                    value={audience}
                    onChange={(event) => setAudience(event.target.value)}
                    maxLength={500}
                    placeholder="People learning to make better coffee at home"
                    disabled={!!busy}
                  />
                </label>
                <fieldset>
                  <legend>Public sources</legend>
                  <div className="social-source-choices">
                    {(['x', 'instagram', 'web'] as const).map((platform) => (
                      <label
                        key={platform}
                        className={`social-source-choice ${platforms.includes(platform) ? 'selected' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={platforms.includes(platform)}
                          disabled={!!busy}
                          onChange={() =>
                            setPlatforms((previous) =>
                              previous.includes(platform)
                                ? previous.filter((item) => item !== platform)
                                : [...previous, platform],
                            )
                          }
                        />
                        <span>{platformNames[platform]}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="social-form-row">
                  <label>
                    Time window
                    <select
                      value={days}
                      disabled={!!busy}
                      onChange={(event) => setDays(Number(event.target.value))}
                    >
                      <option value={7}>Past 7 days</option>
                      <option value={30}>Past 30 days</option>
                      <option value={90}>Past 90 days</option>
                    </select>
                  </label>
                  <label>
                    Result limit
                    <select
                      value={limit}
                      disabled={!!busy}
                      onChange={(event) => setLimit(Number(event.target.value))}
                    >
                      <option value={30}>30 results</option>
                      <option value={60}>60 results</option>
                      <option value={100}>100 results</option>
                    </select>
                  </label>
                </div>
                <button
                  type="submit"
                  className="social-button social-button-primary"
                  disabled={!!busy || !configured || !platforms.length}
                >
                  {busy === 'collect' ? 'Collecting public evidence…' : 'Research this theme'}
                  <ArrowRight size={18} />
                </button>
                {!configured && (
                  <p className="social-caption">
                    No provider is configured for these sources. Set a provider API key on the
                    server or explore the example.
                  </p>
                )}
                <details className="social-provider-details">
                  <summary>Source availability and coverage</summary>
                  {providers.map((provider) => (
                    <div key={provider.id}>
                      <strong>
                        {provider.name}
                        <span className={provider.configured ? 'social-connected' : ''}>
                          {provider.configured ? 'Configured' : 'Needs setup'}
                        </span>
                      </strong>
                      <p>{provider.description}</p>
                      {provider.limitations.map((limitation) => (
                        <p className="social-caption" key={limitation}>
                          {limitation}
                        </p>
                      ))}
                    </div>
                  ))}
                  <p className="social-caption">
                    Public discovery is a sample. Indexed Instagram links do not provide a complete
                    interaction network.
                  </p>
                </details>
                <details className="social-import-details">
                  <summary>Import a public evidence dataset</summary>
                  <p className="social-caption">
                    Paste a JSON dataset with posts, actors, relationships, and warnings arrays
                    using the shared social-data format. No private content or access tokens. Every
                    post must retain its public permalink and provenance.
                  </p>
                  <label htmlFor="social-import-data" className="social-sr-only">
                    Public evidence dataset JSON
                  </label>
                  <textarea
                    id="social-import-data"
                    value={importJson}
                    onChange={(event) => setImportJson(event.target.value)}
                    maxLength={200000}
                    placeholder={'{"posts": [], "actors": [], "relationships": [], "warnings": []}'}
                    disabled={!!busy}
                    spellCheck={false}
                  />
                  <label className="social-select-decision">
                    <input
                      type="checkbox"
                      checked={publicOnly}
                      onChange={(event) => setPublicOnly(event.target.checked)}
                      disabled={!!busy}
                    />
                    This dataset contains public evidence only.
                  </label>
                  <button
                    type="button"
                    className="social-button social-button-secondary"
                    disabled={!!busy || !importJson.trim() || !publicOnly}
                    onClick={() => void importEvidence()}
                  >
                    {busy === 'import' ? 'Importing evidence…' : 'Import public evidence'}
                    <ArrowRight size={16} />
                  </button>
                </details>
              </form>
            </section>
          )}

          {active && (
            <>
              <section className="social-investigation-heading" aria-label="Current investigation">
                <div>
                  <div className="social-investigation-meta">
                    {active.mode === 'demo' && (
                      <span className="social-demo-badge">Synthetic example</span>
                    )}
                    <span>
                      <Clock size={14} />
                      {formatDate(active.createdAt)}
                    </span>
                    <span>
                      {active.platforms.map((platform) => platformNames[platform]).join(' · ')}
                    </span>
                  </div>
                  <h2>{active.topic}</h2>
                  <p>{active.analysis.summary}</p>
                </div>
                <div className="social-coverage-counts">
                  <span>
                    <strong>{active.analysis.coverage.postCount}</strong>posts in sample
                  </span>
                  <span>
                    <strong>{active.analysis.coverage.actorCount}</strong>public actors
                  </span>
                  <span>
                    <strong>{active.analysis.coverage.observedRelationshipCount}</strong>observed
                    links
                  </span>
                </div>
              </section>
              {active.mode === 'demo' && (
                <div className="social-notice social-notice-example">
                  <Lightbulb size={18} />
                  <span>
                    This example demonstrates the workflow. Its posts, accounts, relationships, and
                    metrics are synthetic.
                  </span>
                </div>
              )}
              {!!active.analysis.coverage.warnings.length && (
                <details className="social-coverage-notice">
                  <summary>
                    <WarningCircle size={16} />
                    Coverage notes ({active.analysis.coverage.warnings.length})
                  </summary>
                  <ul>
                    {active.analysis.coverage.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}

              <section className="social-explorer" aria-label="Explore collected evidence">
                <div className="social-explorer-toolbar">
                  <div className="social-view-switch" role="group" aria-label="Evidence view">
                    <button
                      type="button"
                      className={view === 'graph' ? 'selected' : ''}
                      aria-pressed={view === 'graph'}
                      onClick={() => setView('graph')}
                    >
                      <Graph size={17} />
                      Graph
                    </button>
                    <button
                      type="button"
                      className={view === 'list' ? 'selected' : ''}
                      aria-pressed={view === 'list'}
                      onClick={() => setView('list')}
                    >
                      <List size={17} />
                      Evidence list
                    </button>
                  </div>
                  <label className="social-filter-search">
                    <MagnifyingGlass size={17} />
                    <span className="social-sr-only">Filter evidence by content or actor</span>
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Find a post or actor"
                    />
                  </label>
                  <label>
                    <span className="social-sr-only">Filter platform</span>
                    <select
                      value={platformFilter}
                      onChange={(event) =>
                        setPlatformFilter(event.target.value as SocialPlatform | 'all')
                      }
                    >
                      <option value="all">All sources</option>
                      {active.platforms.map((platform) => (
                        <option value={platform} key={platform}>
                          {platformNames[platform]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {dateFilter && (
                  <div className="social-filter-notice">
                    Showing {formatDate(dateFilter)}
                    <button
                      className="social-text-button"
                      onClick={() => setDateFilter('')}
                      type="button"
                    >
                      Clear date <X size={14} />
                    </button>
                  </div>
                )}
                <div className="social-explorer-layout">
                  <div className="social-explorer-main">
                    {view === 'graph' ? (
                      <ResearchGraph
                        key={active.id}
                        nodes={graphNodes}
                        edges={active.analysis.graph.edges}
                        notes={active.notes}
                        selectedId={selectedNode}
                        onSelect={selectGraphNode}
                        onSelectNote={editNote}
                      />
                    ) : (
                      <div className="social-evidence-list">
                        <div className="social-list-caption">
                          {visiblePosts.length} matching posts · metrics remain unknown when
                          unavailable
                        </div>
                        {visiblePosts.map((post) => (
                          <EvidencePost
                            key={post.id}
                            post={post}
                            selected={post.id === selectedPostId}
                            author={
                              active.analysis.actors.find((actor) => actor.id === post.actorId)
                                ?.name
                            }
                            onClick={() => selectPost(post.id)}
                          />
                        ))}
                        {!visiblePosts.length && (
                          <div className="social-empty-inline">
                            <MagnifyingGlass size={24} />
                            <p>No evidence matches these filters.</p>
                            <button
                              className="social-text-button"
                              type="button"
                              onClick={() => {
                                setSearch('');
                                setPlatformFilter('all');
                                setDateFilter('');
                              }}
                            >
                              Clear filters
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="social-sample-footnote">
                      {active.analysis.coverage.postsWithMetrics} posts include public metrics.
                      Content relationships are derived from the collected sample and do not
                      establish amplification.
                    </div>
                  </div>
                  <aside
                    className="social-inspector"
                    ref={inspector}
                    tabIndex={-1}
                    aria-label="Selected evidence and creative note"
                  >
                    {selectedPost ? (
                      <>
                        <div className="social-inspector-heading">
                          <span className="social-platform-badge">
                            {platformNames[selectedPost.platform]}
                          </span>
                          <span>{formatDate(selectedPost.publishedAt)}</span>
                        </div>
                        <h3>{selectedActor?.name ?? 'Public source'}</h3>
                        {selectedActor?.handle && (
                          <p className="social-caption">{selectedActor.handle}</p>
                        )}
                        <p className="social-post-text">{selectedPost.text}</p>
                        <a
                          className="social-source-link"
                          href={selectedPost.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {active.mode === 'demo'
                            ? 'Example source reference'
                            : 'Open original source'}
                          <ArrowUpRight size={16} />
                        </a>
                        <div className="social-metrics">
                          <span>
                            <strong>{formatNumber(selectedPost.metrics.likes)}</strong>likes
                          </span>
                          <span>
                            <strong>{formatNumber(selectedPost.metrics.shares)}</strong>shares
                          </span>
                          <span>
                            <strong>{formatNumber(selectedPost.metrics.views)}</strong>views
                          </span>
                        </div>
                        <p className="social-caption">
                          {selectedPost.provider} · {selectedPost.contentKind.replace('_', ' ')} ·
                          collected {formatDate(selectedPost.collectedAt)}
                        </p>
                        {selectedRank && (
                          <>
                            <h4>What works</h4>
                            <ul className="social-strengths">
                              {selectedRank.strengths.map((strength) => (
                                <li key={strength}>
                                  <Check size={14} />
                                  {strength}
                                </li>
                              ))}
                            </ul>
                            <h4>What to consider</h4>
                            <ul className="social-cautions">
                              {selectedRank.cautions.map((caution) => (
                                <li key={caution}>
                                  <WarningCircle size={14} />
                                  {caution}
                                </li>
                              ))}
                            </ul>
                            <p className="social-caption">{selectedRank.reason}</p>
                          </>
                        )}
                        {focusedNode && focusedNode.kind !== 'post' && (
                          <p className="social-context-label">
                            Selected {focusedNode.kind}: {focusedNode.label}
                          </p>
                        )}
                      </>
                    ) : (
                      <div className="social-inspector-empty">
                        <ChatCircleText size={32} weight="light" />
                        <h3>Every connection has a story.</h3>
                        <p>
                          Select a post, actor, or topic to inspect its evidence and save a creative
                          decision.
                        </p>
                        <button
                          type="button"
                          className="social-text-button"
                          onClick={() => {
                            const first = visiblePosts[0];
                            if (first) selectPost(first.id);
                          }}
                          disabled={!visiblePosts.length}
                        >
                          Explore the first post
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    )}
                    <form className="social-note-editor" onSubmit={(event) => void saveNote(event)}>
                      <h3>
                        <NotePencil size={18} />
                        {editingNote ? 'Edit your note' : 'Make it useful'}
                      </h3>
                      <label>
                        Creative decision
                        <select
                          value={noteKind}
                          onChange={(event) =>
                            setNoteKind(event.target.value as SocialNoteInput['kind'])
                          }
                          disabled={!!busy}
                        >
                          {noteKinds.map((kind) => (
                            <option key={kind} value={kind}>
                              {kind[0]!.toUpperCase() + kind.slice(1)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span className="social-sr-only">Creative note</span>
                        <textarea
                          ref={noteEditor}
                          value={noteText}
                          onChange={(event) => setNoteText(event.target.value)}
                          maxLength={4000}
                          required
                          placeholder="What would you adopt, avoid, or test in your own script?"
                          disabled={!!busy}
                        />
                      </label>
                      <p className="social-caption">
                        {noteEvidenceIds.length
                          ? `Linked to ${noteEvidenceIds.length} source ${noteEvidenceIds.length === 1 ? 'post' : 'posts'}.`
                          : 'A context note without linked evidence.'}
                      </p>
                      <div className="social-inline-actions">
                        <button
                          className="social-button social-button-secondary"
                          type="submit"
                          disabled={!!busy || !noteText.trim()}
                        >
                          {busy === 'note' ? 'Saving…' : editingNote ? 'Save changes' : 'Save note'}
                          <Plus size={16} />
                        </button>
                        {editingNote && (
                          <button
                            type="button"
                            className="social-text-button"
                            onClick={() => {
                              setEditingNote('');
                              setNoteText('');
                            }}
                          >
                            Cancel edit
                          </button>
                        )}
                      </div>
                    </form>
                  </aside>
                </div>
              </section>

              <section className="social-timeline" aria-labelledby="social-timeline-title">
                <div className="social-section-heading">
                  <div>
                    <h3 id="social-timeline-title">The conversation over time</h3>
                    <p>Publication dates in this sample. Select a day to filter the board.</p>
                  </div>
                  <span className="social-caption">
                    {active.analysis.coverage.postCount -
                      active.analysis.coverage.postsWithTimestamps}{' '}
                    dates unknown
                  </span>
                </div>
                {active.analysis.timeline.length ? (
                  <div className="social-timeline-bars">
                    {active.analysis.timeline.map((bucket) => (
                      <button
                        key={bucket.date}
                        className={dateFilter === bucket.date ? 'selected' : ''}
                        type="button"
                        aria-label={`${formatDate(bucket.date)}: ${bucket.posts} posts. Filter to this day.`}
                        aria-pressed={dateFilter === bucket.date}
                        onClick={() =>
                          setDateFilter((previous) => (previous === bucket.date ? '' : bucket.date))
                        }
                      >
                        <span className="social-timeline-value">{bucket.posts}</span>
                        <span
                          className="social-timeline-bar"
                          style={{
                            height: `${Math.max(8, (bucket.posts / Math.max(...active.analysis.timeline.map((item) => item.posts), 1)) * 80)}px`,
                          }}
                        />
                        <span>{formatDate(bucket.date)}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="social-empty-text">
                    No verified publication dates are available. Collection time does not establish
                    when a narrative started.
                  </p>
                )}
              </section>

              <div className="social-decisions-layout">
                <section className="social-findings" aria-labelledby="social-findings-title">
                  <div className="social-section-heading">
                    <div>
                      <h3 id="social-findings-title">From evidence to an angle</h3>
                      <p>
                        Review the strengths and tradeoffs before sending a finding to your script.
                      </p>
                    </div>
                    <Lightbulb size={24} weight="light" />
                  </div>
                  {active.analysis.insights.map((insight) => (
                    <Finding
                      key={insight.id}
                      insight={insight}
                      selected={selectedInsights.includes(insight.id)}
                      disabled={!!busy}
                      onToggle={() => toggleSelection(insight.id, 'insight')}
                      onEvidence={(id) => selectPost(id)}
                    />
                  ))}
                  {!active.analysis.insights.length && (
                    <p className="social-empty-text">
                      More public evidence is needed before suggesting a creative pattern.
                    </p>
                  )}
                </section>
                <section className="social-notes-panel" aria-labelledby="social-notes-title">
                  <div className="social-section-heading">
                    <div>
                      <h3 id="social-notes-title">
                        Your creative decisions <span>{active.notes.length}</span>
                      </h3>
                      <p>The parts you want to carry into creation.</p>
                    </div>
                    <BookmarkSimple size={22} weight="light" />
                  </div>
                  {active.notes.map((note) => (
                    <article className={`social-saved-note social-note-${note.kind}`} key={note.id}>
                      <div className="social-note-top">
                        <span className="social-note-type">{note.kind}</span>
                        <label className="social-select-decision">
                          <input
                            type="checkbox"
                            checked={selectedNotes.includes(note.id)}
                            disabled={!!busy}
                            onChange={() => toggleSelection(note.id, 'note')}
                          />
                          Use in script
                        </label>
                      </div>
                      <p>{note.text}</p>
                      <div className="social-note-footer">
                        <span>
                          {note.evidenceIds.length} source{' '}
                          {note.evidenceIds.length === 1 ? 'post' : 'posts'}
                        </span>
                        <button
                          type="button"
                          className="social-text-button"
                          onClick={() => editNote(note)}
                          disabled={!!busy}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete note: ${snippet(note.text, 40)}`}
                          className="social-icon-button"
                          disabled={!!busy}
                          onClick={() => void removeNote(note)}
                        >
                          <Trash size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                  {!active.notes.length && (
                    <div className="social-empty-inline">
                      <NotePencil size={28} weight="light" />
                      <p>Spot something worth using?</p>
                      <span>Select evidence and save an adopt, avoid, test, or context note.</span>
                    </div>
                  )}
                  <div className="social-handoff-tray">
                    <h3>Give your script a direction.</h3>
                    <p>
                      {selectedNotes.length} notes and {selectedInsights.length} findings selected.
                      Source references travel with them.
                    </p>
                    <button
                      type="button"
                      className="social-button social-button-primary"
                      disabled={!!busy || !(selectedNotes.length + selectedInsights.length)}
                      onClick={() => void prepareHandoff()}
                    >
                      {busy === 'handoff' ? 'Preparing direction…' : 'Review script direction'}
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </section>
              </div>

              {handoff && (
                <section className="social-handoff-preview" aria-labelledby="social-handoff-title">
                  <div className="social-section-heading">
                    <div>
                      <h3 id="social-handoff-title">Your research, ready for the script</h3>
                      <p>
                        Review this direction. External examples guide the creative approach; your
                        own brief supplies product facts.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="social-icon-button"
                      aria-label="Close script direction preview"
                      onClick={() => setHandoff(null)}
                    >
                      <X size={20} />
                    </button>
                  </div>
                  <div className="social-direction-copy">{handoff.creativeDirection}</div>
                  {!!handoff.cautions.length && (
                    <ul className="social-handoff-cautions">
                      {handoff.cautions.map((caution) => (
                        <li key={caution}>{caution}</li>
                      ))}
                    </ul>
                  )}
                  <div className="social-handoff-sources">
                    {handoff.evidence.map((evidence, index) => (
                      <a key={evidence.postId} href={evidence.url} target="_blank" rel="noreferrer">
                        Source {index + 1}
                        <ArrowUpRight size={14} />
                      </a>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="social-button social-button-primary"
                    disabled={!!busy || !onUseResearch || used}
                    onClick={() => void useResearch()}
                  >
                    {busy === 'apply'
                      ? 'Sending to creation…'
                      : used
                        ? 'Sent to creation'
                        : 'Use this direction in a script'}
                    {used ? <Check size={18} /> : <ArrowRight size={18} />}
                  </button>
                  {!onUseResearch && (
                    <p className="social-caption">
                      The creation handoff is not connected in this host. Your selected direction
                      and source references remain available above.
                    </p>
                  )}
                </section>
              )}

              <section className="social-query-panel" aria-labelledby="social-query-title">
                <div>
                  <span className="social-section-icon">
                    <ChatCircleText size={22} />
                  </span>
                  <h3 id="social-query-title">Ask the evidence.</h3>
                  <p>
                    Retrieve relevant messages and actors from this investigation. Answers use the
                    collected sample.
                  </p>
                  <span className="social-caption">
                    Extractive retrieval · no additional web search
                  </span>
                </div>
                <div>
                  <form onSubmit={(event) => void ask(event)}>
                    <label htmlFor="social-question" className="social-sr-only">
                      Question about the current investigation
                    </label>
                    <textarea
                      id="social-question"
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      maxLength={2000}
                      placeholder="Which examples explain the audience's problem most clearly?"
                      required
                      disabled={!!busy}
                    />
                    <button
                      type="submit"
                      className="social-button social-button-secondary"
                      disabled={!!busy || !question.trim()}
                    >
                      {busy === 'query' ? 'Retrieving evidence…' : 'Find an answer'}
                      <ArrowRight size={18} />
                    </button>
                  </form>
                  {answer && (
                    <div className="social-query-answer" aria-live="polite">
                      <span className="social-caption">
                        {answer.confidence} confidence within this sample
                      </span>
                      <p>{answer.answer}</p>
                      {answer.evidence.map((evidence, index) => (
                        <button
                          key={evidence.postId}
                          className="social-query-evidence"
                          onClick={() => {
                            selectPost(evidence.postId);
                            inspector.current?.scrollIntoView({ behavior: 'auto', block: 'start' });
                          }}
                          type="button"
                        >
                          <span>{index + 1}</span>
                          {snippet(evidence.excerpt, 140)}
                          <ArrowUpRight size={16} />
                        </button>
                      ))}
                      {answer.limitations.map((limitation) => (
                        <p className="social-caption" key={limitation}>
                          {limitation}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              <footer className="social-research-footer">
                <p>
                  Public evidence only. Analysis describes this sample, without claiming complete
                  platform coverage or guaranteed performance.
                </p>
                {confirmDelete ? (
                  <div className="social-inline-actions">
                    <span>Delete this research and its notes?</span>
                    <button
                      type="button"
                      className="social-text-button social-danger"
                      onClick={() => void deleteInvestigation()}
                      disabled={!!busy}
                    >
                      Delete research
                    </button>
                    <button
                      type="button"
                      className="social-text-button"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep it
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="social-text-button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={!!busy}
                  >
                    <Trash size={15} />
                    Delete investigation
                  </button>
                )}
              </footer>
            </>
          )}
        </>
      )}
    </div>
  );
}

function EvidencePost({
  post,
  author,
  selected,
  onClick,
}: {
  post: SocialPost;
  author?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`social-evidence-post ${selected ? 'selected' : ''}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className="social-evidence-top">
        <span className="social-platform-badge">{platformNames[post.platform]}</span>
        <span>{formatDate(post.publishedAt)}</span>
      </span>
      <strong>{author ?? 'Public source'}</strong>
      <p>{snippet(post.text, 240)}</p>
      <span className="social-evidence-bottom">
        <span>
          {post.metrics.likes === null
            ? 'Engagement unavailable'
            : `${formatNumber(post.metrics.likes)} likes`}
        </span>
        <span>
          Inspect evidence
          <ArrowRight size={15} />
        </span>
      </span>
    </button>
  );
}

function Finding({
  insight,
  selected,
  disabled,
  onToggle,
  onEvidence,
}: {
  insight: SocialInsight;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onEvidence: (id: string) => void;
}) {
  return (
    <article className="social-finding">
      <div className="social-finding-top">
        <span className={`social-finding-kind social-finding-${insight.kind}`}>{insight.kind}</span>
        <span className="social-caption">{insight.confidence} confidence</span>
      </div>
      <h4>{insight.title}</h4>
      <p>{insight.description}</p>
      <div className="social-finding-tradeoffs">
        <div>
          <strong>Strengths</strong>
          <ul>
            {insight.pros.map((pro) => (
              <li key={pro}>{pro}</li>
            ))}
          </ul>
        </div>
        <div>
          <strong>Tradeoffs</strong>
          <ul>
            {insight.cons.map((con) => (
              <li key={con}>{con}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="social-script-angle">
        <NotePencil size={16} />
        <span>{insight.scriptAngle}</span>
      </p>
      <div className="social-finding-footer">
        <div className="social-evidence-links">
          {insight.evidenceIds.slice(0, 3).map((id, index) => (
            <button key={id} type="button" onClick={() => onEvidence(id)}>
              Evidence {index + 1}
              <ArrowUpRight size={13} />
            </button>
          ))}
        </div>
        <label className="social-select-decision">
          <input type="checkbox" checked={selected} disabled={disabled} onChange={onToggle} />
          Use in script
        </label>
      </div>
    </article>
  );
}
