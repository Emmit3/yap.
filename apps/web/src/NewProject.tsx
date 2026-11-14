import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, FilmStrip, NotePencil, Quotes } from '@phosphor-icons/react';
import { createProjectSchema, type Project, type ProjectBrief } from '@yap/contracts';
import type { SocialHandoff } from '@yap/contracts/social';
import { api, messageOf } from './api';
import { BriefFields, ErrorNotice, PageHeading } from './components';

const initialBrief: ProjectBrief = {
  title: '',
  idea: '',
  audience: '',
  platform: 'instagram',
  duration: 30,
  tone: 'conversational',
  goal: 'educate',
};

export function NewProject({
  onBack,
  onCreated,
  onDirty,
  initialResearch,
}: {
  onBack(): void;
  onCreated(project: Project): void;
  onDirty(dirty: boolean): void;
  initialResearch?: SocialHandoff;
}) {
  const [brief, setBrief] = useState<ProjectBrief>(() => initialResearch ? {
    ...initialBrief,
    title: initialResearch.topic.slice(0, 120),
    audience: initialResearch.audience.slice(0, 200),
    research: initialResearch,
  } : initialBrief);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function change(value: ProjectBrief) {
    setBrief(value);
    onDirty(JSON.stringify(value) !== JSON.stringify(initialBrief));
    setErrors({});
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    const result = createProjectSchema.safeParse(brief);
    if (!result.success) {
      setErrors(
        Object.fromEntries(
          result.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
        ),
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { project } = await api.create(result.data);
      onDirty(false);
      onCreated(project);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="text-button back-button" onClick={onBack}>
        <ArrowLeft size={16} /> All projects
      </button>
      <PageHeading
        eyebrow="A little context goes a long way"
        title="Let’s hear your idea."
        copy="It doesn’t have to be polished. Just give it a place to start."
      />
      <div className="create-layout">
        <form className="brief-panel" onSubmit={create} noValidate>
          {error && <ErrorNotice message={error} onDismiss={() => setError('')} />}
          {brief.research && (
            <section className="research-brief-context" aria-label="Selected research direction">
              <h2>Your research is attached</h2>
              <p>Add your own idea and product facts below. The selected research guides presentation and keeps its source links with this project.</p>
              <details>
                <summary>Review selected direction and {brief.research.sourceUrls.length} sources</summary>
                <p style={{ whiteSpace: 'pre-wrap' }}>{brief.research.creativeDirection}</p>
                <ul>{brief.research.sourceUrls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul>
              </details>
              <button type="button" className="text-button" disabled={busy} onClick={() => {
                const { research: _research, ...withoutResearch } = brief;
                change(withoutResearch);
              }}>Remove research direction</button>
            </section>
          )}
          <BriefFields value={brief} onChange={change} errors={errors} disabled={busy} />
          <div className="form-footer">
            <span>You can change all of this later.</span>
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? 'Saving your idea…' : 'Create project'}
              {!busy && <ArrowRight size={18} />}
            </button>
          </div>
        </form>
        <aside className="creation-aside">
          <div className="aside-heading">
            <span className="small-brand">
              yap<span>.</span>
            </span>
            <span className="tag">THE PROCESS</span>
          </div>
          <h2>
            A little structure.
            <br />A lot of possibility.
          </h2>
          <p>Keep your idea, words, and camera notes in one place.</p>
          <ol className="process-list">
            <li>
              <span className="process-icon">
                <NotePencil size={20} />
              </span>
              <div>
                <strong>Get the idea down</strong>
                <p>A brief that keeps the story focused.</p>
              </div>
            </li>
            <li>
              <span className="process-icon">
                <Quotes size={20} />
              </span>
              <div>
                <strong>Find your words</strong>
                <p>A guided draft you can make your own.</p>
              </div>
            </li>
            <li>
              <span className="process-icon">
                <FilmStrip size={20} />
              </span>
              <div>
                <strong>Picture every shot</strong>
                <p>A timed plan for what to film.</p>
              </div>
            </li>
          </ol>
          <div className="aside-note">
            <Check size={18} />
            <p>You’re in control. Edit every line before you call it ready.</p>
          </div>
        </aside>
      </div>
    </>
  );
}
