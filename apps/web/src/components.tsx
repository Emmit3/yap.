import {
  ArrowRight,
  ArrowUpRight,
  Check,
  FilmStrip,
  Plus,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { Project, ProjectBrief } from '@yap/contracts';

export const platformNames = {
  instagram: 'Instagram Reels',
  tiktok: 'TikTok',
  youtube: 'YouTube Shorts',
};
export const toneNames = {
  conversational: 'Conversational',
  educational: 'Educational',
  bold: 'Bold',
};
export const goalNames = {
  educate: 'Teach something',
  entertain: 'Entertain',
  promote: 'Promote an idea',
};

export function ErrorNotice({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="notice notice-error" role="alert">
      <WarningCircle size={22} />
      <span>{message}</span>
      {onRetry && (
        <button className="text-button" onClick={onRetry}>
          Try again <ArrowRight size={16} />
        </button>
      )}
      {onDismiss && (
        <button className="icon-button" aria-label="Dismiss error" onClick={onDismiss}>
          <X size={18} />
        </button>
      )}
    </div>
  );
}

export function Status({ status }: { status: Project['status'] }) {
  return (
    <span className={`status status-${status}`}>
      {status === 'ready' ? <Check size={12} weight="bold" /> : <span className="status-dot" />}
      {status === 'ready' ? 'Ready to film' : 'Draft'}
    </span>
  );
}

export function LoadingState({ label = 'Opening your workspace' }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-label={label}>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-copy" />
      <div className="loading-cards">
        {[0, 1, 2].map((n) => (
          <div className="skeleton skeleton-card" key={n} />
        ))}
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function PageHeading({
  eyebrow,
  title,
  copy,
  children,
}: {
  eyebrow?: string;
  title: string;
  copy?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {copy && <p className="page-description">{copy}</p>}
      </div>
      {children}
    </div>
  );
}

export function BriefFields({
  value,
  onChange,
  errors = {},
  disabled = false,
}: {
  value: ProjectBrief;
  onChange(value: ProjectBrief): void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  const set = <K extends keyof ProjectBrief>(key: K, entry: ProjectBrief[K]) =>
    onChange({ ...value, [key]: entry });
  const fieldError = (name: string) =>
    errors[name] ? (
      <span className="field-error" id={`error-${name}`}>
        {errors[name]}
      </span>
    ) : null;
  return (
    <fieldset className="brief-fields" disabled={disabled}>
      <div className="field">
        <label htmlFor="title">Project name</label>
        <input
          id="title"
          autoComplete="off"
          value={value.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="e.g. The five minute morning reset"
          maxLength={120}
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? 'error-title' : undefined}
        />
        {fieldError('title')}
      </div>
      <div className="field">
        <div className="field-label">
          <label htmlFor="idea">What’s the idea?</label>
          <span>{value.idea.length}/4,000</span>
        </div>
        <textarea
          id="idea"
          className="idea-input"
          value={value.idea}
          onChange={(e) => set('idea', e.target.value)}
          placeholder="Tell us what you want to share. A useful tip, a story, something you wish more people knew…"
          maxLength={4000}
          aria-invalid={!!errors.idea}
          aria-describedby={errors.idea ? 'error-idea' : 'idea-hint'}
        />
        <span className="field-hint" id="idea-hint">
          A specific detail gives your draft somewhere to start.
        </span>
        {fieldError('idea')}
      </div>
      <div className="field">
        <label htmlFor="audience">Who’s watching?</label>
        <input
          id="audience"
          value={value.audience}
          onChange={(e) => set('audience', e.target.value)}
          placeholder="e.g. Busy students who want a calmer morning"
          maxLength={200}
          aria-invalid={!!errors.audience}
          aria-describedby={errors.audience ? 'error-audience' : undefined}
        />
        {fieldError('audience')}
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="platform">Platform</label>
          <select
            id="platform"
            value={value.platform}
            onChange={(e) => set('platform', e.target.value as ProjectBrief['platform'])}
          >
            {Object.entries(platformNames).map(([key, name]) => (
              <option value={key} key={key}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="duration">Video length</label>
          <select
            id="duration"
            value={value.duration}
            onChange={(e) => set('duration', Number(e.target.value) as ProjectBrief['duration'])}
          >
            <option value={15}>15 seconds</option>
            <option value={20}>20 seconds</option>
            <option value={30}>30 seconds</option>
            <option value={60}>60 seconds</option>
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="tone">How should it sound?</label>
          <select
            id="tone"
            value={value.tone}
            onChange={(e) => set('tone', e.target.value as ProjectBrief['tone'])}
          >
            {Object.entries(toneNames).map(([key, name]) => (
              <option value={key} key={key}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="goal">What’s the goal?</label>
          <select
            id="goal"
            value={value.goal}
            onChange={(e) => set('goal', e.target.value as ProjectBrief['goal'])}
          >
            {Object.entries(goalNames).map(([key, name]) => (
              <option value={key} key={key}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </fieldset>
  );
}

export function FilmSketch() {
  return (
    <div className="film-sketch" aria-hidden="true">
      <div className="film-perforations">
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className="sketch-scenes">
        <div className="sketch-scene">
          <span className="sketch-time">00:00</span>
          <div className="sketch-play">
            <FilmStrip size={36} weight="light" />
          </div>
          <strong>A little spark.</strong>
        </div>
        <div className="sketch-scene sketch-scene-accent">
          <span className="sketch-time">00:03</span>
          <div className="sketch-lines">
            <i />
            <i />
            <i />
          </div>
          <strong>A story to tell.</strong>
        </div>
        <div className="sketch-scene">
          <span className="sketch-time">00:30</span>
          <ArrowUpRight size={40} weight="light" />
          <strong>Something worth sharing.</strong>
        </div>
      </div>
      <div className="film-perforations">
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} />
        ))}
      </div>
    </div>
  );
}

export function PrimaryCreate({
  onClick,
  children = 'New project',
}: {
  onClick(): void;
  children?: ReactNode;
}) {
  return (
    <button className="button button-primary" onClick={onClick}>
      <Plus size={18} />
      {children}
    </button>
  );
}

export function timeAgo(date: string) {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
