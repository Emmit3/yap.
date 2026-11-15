import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, FilmStrip, NotePencil, Quotes } from '@phosphor-icons/react';
import { createProjectSchema, type Project, type ProjectBrief } from '@yap/contracts';
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
const fieldLabels: Record<string, string> = {
  title: 'project name',
  idea: 'idea',
  audience: 'audience',
  platform: 'platform',
  duration: 'video length',
  tone: 'tone',
  goal: 'goal',
};

export function NewProject({
  onBack,
  onCreated,
  onDirty,
}: {
  onBack(): void;
  onCreated(project: Project): void;
  onDirty(dirty: boolean): void;
}) {
  const [brief, setBrief] = useState<ProjectBrief>(initialBrief);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);
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
          result.error.issues.map((issue) => {
            const field = String(issue.path[0]);
            const label = fieldLabels[field] ?? 'field';
            const message =
              issue.code === 'too_small'
                ? field === 'title' && issue.minimum === 1
                  ? 'Give your project a name.'
                  : `Describe your ${label} in at least ${issue.minimum} characters.`
                : issue.code === 'too_big'
                  ? `Use ${issue.maximum} characters or fewer for your ${label}.`
                  : `Check your ${label} and try again.`;
            return [field, message];
          }),
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
        <form ref={form} className="brief-panel" onSubmit={create} noValidate>
          {error && <ErrorNotice message={error} onDismiss={() => setError('')} />}
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
