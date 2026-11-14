import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowsClockwise,
  Check,
  CheckCircle,
  Circle,
  FileText,
  Files,
  GitBranch,
  Lightning,
  MagnifyingGlass,
  Pause,
  Sparkle,
  Stop,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import type { SocialResearchRun } from '@yap/contracts/social';
import { researchError, socialApi } from './api';
import './activity.css';

const specialists = [
  {
    id: 'source_researcher',
    name: 'Source researcher',
    task: 'Find public evidence',
    Icon: MagnifyingGlass,
    file: '/research/sources.json',
  },
  {
    id: 'network_analyst',
    name: 'Network analyst',
    task: 'Connect content and actors',
    Icon: GitBranch,
    file: '/research/network.json',
  },
  {
    id: 'creative_strategist',
    name: 'Creative strategist',
    task: 'Find an original script angle',
    Icon: Sparkle,
    file: '/research/insights.json',
  },
] as const;
const stages = ['scope', 'collect', 'normalize', 'analyze', 'brief', 'persist'];
const fileNames = ['scope.json', 'sources.json', 'network.json', 'insights.json', 'brief.md'];
const terminal = (status: SocialResearchRun['status']) =>
  ['completed', 'failed', 'canceled'].includes(status);
const basename = (path: string) => path.split('/').pop() ?? path;

export default function ResearchActivity({
  run,
  connected,
  resultLoaded,
  resultOpen,
  onOpenResults,
  onCancel,
  onReconnect,
  onDismiss,
}: {
  run: SocialResearchRun;
  connected: boolean;
  resultLoaded: boolean;
  resultOpen: boolean;
  onOpenResults(): void;
  onCancel(): void;
  onReconnect(): void;
  onDismiss(): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [filePath, setFilePath] = useState('');
  const [preview, setPreview] = useState<{ content: string; truncated: boolean } | null>(null);
  const [fileError, setFileError] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [tab, setTab] = useState<'activity' | 'files'>('activity');
  const ended = terminal(run.status);
  const completedStages = new Set(
    run.events.filter((event) => event.phase === 'completed').map((event) => event.task),
  );
  const stageCount = stages.filter((stage) =>
    completedStages.has(stage as (typeof run.events)[number]['task']),
  ).length;
  const progress = run.status === 'completed' ? stages.length : stageCount;
  const lastEvent = run.events[run.events.length - 1];
  const replay = run.execution === 'demo_replay';
  const harness = run.execution === 'deepagents';
  const evidenceCount = run.events
    .filter((event) => event.task === 'collect' && event.phase === 'completed')
    .reduce((maximum, event) => Math.max(maximum, event.resultCount ?? 0), 0);

  useEffect(() => {
    setExpanded(true);
    setFilePath('');
    setPreview(null);
    setFileError('');
  }, [run.id]);
  useEffect(() => {
    if (!filePath) return;
    const controller = new AbortController();
    setFileLoading(true);
    setFileError('');
    setPreview(null);
    void socialApi
      .runArtifact(run.id, filePath, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result.artifact);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFileError(researchError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setFileLoading(false);
      });
    return () => controller.abort();
  }, [run.id, filePath]);

  return (
    <section
      className={`research-activity research-activity-${run.status}`}
      aria-labelledby="research-activity-title"
    >
      <header className="research-activity-header">
        <div className="research-activity-title-group">
          <span className={`research-live-indicator ${ended ? 'ended' : ''}`} aria-hidden="true" />
          <div>
            <span className="research-runtime-label">
              {replay
                ? 'Example replay'
                : harness
                  ? 'LangChain Deep Agents'
                  : 'Live research pipeline'}
            </span>
            <h2 id="research-activity-title">
              {run.status === 'completed'
                ? 'Research, connected.'
                : run.status === 'canceled'
                  ? 'Research canceled.'
                  : run.status === 'failed'
                    ? 'This run needs attention.'
                    : 'Watch the idea take shape.'}
            </h2>
          </div>
        </div>
        <div className="research-activity-actions">
          {!connected && (!ended || (run.status === 'completed' && !resultLoaded)) ? (
            <button className="social-text-button" type="button" onClick={onReconnect}>
              <ArrowsClockwise size={16} />
              Reconnect
            </button>
          ) : ended ? (
            <span className="research-run-state">
              {run.status === 'completed' ? <CheckCircle size={18} /> : <Pause size={18} />}
              {run.status}
            </span>
          ) : (
            <button
              className="social-text-button"
              type="button"
              disabled={!run.canCancel}
              onClick={onCancel}
            >
              <Stop size={16} />
              {run.canCancel ? 'Cancel run' : 'Saving evidence…'}
            </button>
          )}
          <button
            className="social-text-button"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
          {ended && (
            <button
              type="button"
              className="research-dismiss"
              aria-label="Dismiss research activity"
              onClick={onDismiss}
            >
              <X size={18} />
            </button>
          )}
        </div>
      </header>
      <p className="research-run-topic">{run.input.topic}</p>
      {replay && (
        <p className="research-execution-note">
          <Lightning size={16} />
          Illustrative replay with synthetic evidence. No agents or external searches are running.
        </p>
      )}
      {!replay && !harness && (
        <p className="research-execution-note">
          Public source calls and local analysis are shown as they happen. This run uses the direct
          pipeline.
        </p>
      )}
      {harness && (
        <p className="research-execution-note">
          <GitBranch size={16} />A Deep Agents coordinator delegates specialist tasks and shares
          evidence through a virtual filesystem.
        </p>
      )}
      {!connected && (!ended || (run.status === 'completed' && !resultLoaded)) && (
        <p className="research-connection-note" role="alert">
          {run.status === 'completed'
            ? 'The research was saved, but its evidence could not be loaded. Reconnect to open the result.'
            : 'The activity connection was interrupted. The server run may still be active; reconnect to check it.'}
        </p>
      )}
      {run.error && (
        <p className="research-connection-note" role="alert">
          <WarningCircle size={16} />
          {run.error.message}
        </p>
      )}
      {expanded && (
        <>
          <div className="research-cockpit">
            <div className="research-agent-map">
              <div className="research-coordinator">
                <div className="research-agent-icon">
                  <GitBranch size={22} />
                </div>
                <div>
                  <strong>{harness ? 'Research coordinator' : 'Research plan'}</strong>
                  <span>
                    {run.status === 'completed'
                      ? 'Evidence ready for your decisions'
                      : replay
                        ? 'Replaying the example workflow'
                        : 'Scope, delegate, and assemble'}
                  </span>
                </div>
                {run.status === 'completed' && <Check size={18} />}
              </div>
              <div className="research-delegation-lines" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div className="research-specialists">
                {specialists.map(({ id, name, task, Icon }) => {
                  const events = run.events.filter((event) => event.agent === id);
                  const latest = events[events.length - 1];
                  const state =
                    latest?.phase === 'failed'
                      ? 'failed'
                      : latest?.phase === 'completed'
                        ? 'completed'
                        : latest
                          ? ended
                            ? 'stopped'
                            : 'working'
                          : 'waiting';
                  return (
                    <article
                      className={`research-specialist research-specialist-${state}`}
                      key={id}
                    >
                      <div className="research-specialist-heading">
                        <Icon size={20} />
                        <span>{state === 'working' ? 'In progress' : state}</span>
                      </div>
                      <h3>{name}</h3>
                      <p>{task}</p>
                      <div className="research-specialist-status">
                        {state === 'completed' ? (
                          <CheckCircle size={16} />
                        ) : state === 'working' ? (
                          <span className="research-task-pulse" />
                        ) : (
                          <Circle size={14} />
                        )}
                        <span>{latest?.message ?? 'Waiting for the previous stage'}</span>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="research-stage-progress">
                <div>
                  <span>
                    {run.status === 'completed' ? 'Ready to explore' : 'Research progress'}
                  </span>
                  <strong>
                    {progress} of {stages.length} stages
                  </strong>
                </div>
                <progress
                  value={progress}
                  max={stages.length}
                  aria-label="Completed research stages"
                />
                <div className="research-stage-labels">
                  <span>Scope</span>
                  <span>Sources</span>
                  <span>Connections</span>
                  <span>Direction</span>
                </div>
              </div>
              <div className="research-run-totals">
                <span>
                  <strong>{evidenceCount || '—'}</strong> evidence items
                </span>
                <span>
                  <strong>{run.artifacts.length}</strong> research files
                </span>
                <span>
                  <strong>{replay ? 'Replay' : harness ? 'Deep Agents' : 'Direct'}</strong>{' '}
                  execution
                </span>
              </div>
            </div>
            <div className="research-trace-panel">
              <div
                className="research-trace-tabs"
                role="tablist"
                aria-label="Research activity views"
              >
                <button
                  id="research-activity-tab"
                  role="tab"
                  type="button"
                  aria-selected={tab === 'activity'}
                  aria-controls="research-activity-events"
                  tabIndex={tab === 'activity' ? 0 : -1}
                  onClick={() => setTab('activity')}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                      setTab('files');
                      document.getElementById('research-files-tab')?.focus();
                    }
                  }}
                >
                  <Lightning size={16} />
                  Activity
                </button>
                <button
                  id="research-files-tab"
                  role="tab"
                  type="button"
                  aria-selected={tab === 'files'}
                  aria-controls="research-activity-files"
                  tabIndex={tab === 'files' ? 0 : -1}
                  onClick={() => setTab('files')}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                      setTab('activity');
                      document.getElementById('research-activity-tab')?.focus();
                    }
                  }}
                >
                  <Files size={16} />
                  Files <span>{run.artifacts.length}</span>
                </button>
              </div>
              {tab === 'activity' ? (
                <div
                  className="research-event-log"
                  id="research-activity-events"
                  role="tabpanel"
                  aria-labelledby="research-activity-tab"
                  tabIndex={0}
                >
                  {run.events
                    .slice(-30)
                    .reverse()
                    .map((event) => (
                      <div
                        key={event.sequence}
                        className={`research-trace-event research-trace-${event.phase}`}
                      >
                        <span className="research-event-mark" aria-hidden="true">
                          {event.phase === 'completed' ? (
                            <Check size={12} />
                          ) : event.phase === 'failed' ? (
                            <X size={12} />
                          ) : (
                            <Circle size={10} />
                          )}
                        </span>
                        <div>
                          <div className="research-event-meta">
                            <span>{event.provider ?? event.agent.replaceAll('_', ' ')}</span>
                            <time dateTime={event.at}>
                              +
                              {Math.max(
                                0,
                                Math.round(
                                  (Date.parse(event.at) - Date.parse(run.createdAt)) / 1000,
                                ),
                              )}
                              s
                            </time>
                          </div>
                          <p>{event.message}</p>
                          {event.search && (
                            <span className="research-search-query">
                              <MagnifyingGlass size={12} />
                              {event.search}
                            </span>
                          )}
                          {event.artifactPath && (
                            <button
                              type="button"
                              className="research-event-file"
                              onClick={() => {
                                setFilePath(event.artifactPath!);
                                setTab('files');
                              }}
                            >
                              <FileText size={12} />
                              {basename(event.artifactPath)}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  {!run.events.length && (
                    <p className="research-log-empty">Preparing a bounded research plan…</p>
                  )}
                  {run.eventsTruncated && (
                    <p className="research-log-empty">
                      Earlier activity was trimmed to keep this run bounded.
                    </p>
                  )}
                </div>
              ) : (
                <div
                  id="research-activity-files"
                  className="research-file-panel"
                  role="tabpanel"
                  aria-labelledby="research-files-tab"
                  tabIndex={0}
                >
                  <p className="research-file-intro">
                    {harness
                      ? 'Shared virtual research files'
                      : replay
                        ? 'Illustrative example artifacts'
                        : 'Artifacts from this research run'}
                  </p>
                  <div className="research-file-list">
                    {fileNames.map((name) => {
                      const file = run.artifacts.find((item) => basename(item.path) === name);
                      return (
                        <button
                          type="button"
                          key={name}
                          disabled={!file}
                          aria-pressed={filePath === file?.path}
                          onClick={() => {
                            if (file) setFilePath(file.path);
                          }}
                        >
                          <FileText size={18} />
                          <span>
                            {name}
                            <small>
                              {file
                                ? `${Math.max(1, Math.round(file.bytes / 1024))} KB · created`
                                : 'Not created yet'}
                            </small>
                          </span>
                          {file && <ArrowRight size={16} />}
                        </button>
                      );
                    })}
                  </div>
                  {filePath && (
                    <div className="research-file-preview">
                      <div>
                        <strong>{basename(filePath)}</strong>
                        <button
                          type="button"
                          aria-label="Close file preview"
                          onClick={() => setFilePath('')}
                        >
                          <X size={14} />
                        </button>
                      </div>
                      {fileLoading ? (
                        <p role="status">Loading research file…</p>
                      ) : fileError ? (
                        <p role="alert">{fileError}</p>
                      ) : (
                        <>
                          <pre tabIndex={0} aria-label={`${basename(filePath)} content`}>
                            {preview?.content}
                          </pre>
                          {preview?.truncated && (
                            <p>Preview shortened. The stored file contains more content.</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <footer className="research-activity-footer">
            <span>
              {run.status === 'completed'
                ? resultOpen
                  ? 'Your evidence graph and creative findings are ready below.'
                  : resultLoaded
                    ? 'Research saved. Open it when you are ready to explore.'
                    : 'Research saved. Loading its evidence…'
                : (lastEvent?.message ?? 'Waiting for the first task to start.')}
            </span>
            {run.status === 'completed' && resultLoaded && !resultOpen ? (
              <button className="social-text-button" type="button" onClick={onOpenResults}>
                Open evidence
                <ArrowRight size={16} />
              </button>
            ) : (
              <span>Public task activity · source evidence · research files</span>
            )}
          </footer>
        </>
      )}
      <p className="social-sr-only" role="status">
        {run.status === 'completed'
          ? 'Research completed. Evidence is ready to explore.'
          : run.status === 'failed'
            ? 'Research failed. Review the source error.'
            : run.status === 'canceled'
              ? 'Research canceled.'
              : `Research is running. ${progress} of ${stages.length} stages complete.`}
      </p>
    </section>
  );
}
