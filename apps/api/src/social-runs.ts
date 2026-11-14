import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  socialResearchArtifactPathSchema,
  socialResearchEventInputSchema,
  socialResearchRunInputSchema,
  socialResearchRunSchema,
  type SocialResearchArtifact,
  type SocialResearchArtifactPath,
  type SocialResearchEventInput,
  type SocialResearchRun,
  type SocialResearchRunInput,
  type SocialResearchInput,
  type SocialDataset,
} from '@yap/contracts/social';
import { ApiError } from './errors.js';

const MAX_ACTIVE = 2;
const MAX_RETAINED = 50;
const MAX_EVENTS = 200;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const RETENTION_MS = 30 * 60 * 1000;
type Artifact = SocialResearchArtifact & { content: string; truncated: boolean };
export interface SocialResearchRunContext {
  input: SocialResearchRunInput;
  signal: AbortSignal;
  emit: (event: SocialResearchEventInput) => void;
  writeArtifact: (path: SocialResearchArtifactPath, content: string) => void;
  commit: (operation: () => Promise<string>) => Promise<string>;
}
export type SocialResearchRunExecutor = (context: SocialResearchRunContext) => Promise<string>;
export interface SocialDeepAgentsContext extends SocialResearchRunContext {
  collect: (input: SocialResearchInput, signal: AbortSignal) => Promise<SocialDataset>;
}
export type SocialDeepAgentsRunner = (context: SocialDeepAgentsContext) => Promise<SocialDataset>;
export interface SocialResearchRunOptions {
  timeoutMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}
interface Entry {
  run: SocialResearchRun;
  controller: AbortController;
  artifacts: Map<SocialResearchArtifactPath, Artifact>;
  done: Promise<void>;
  terminalAt?: number;
  committing?: boolean;
}

function terminal(status: SocialResearchRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

/** Ephemeral run telemetry; completed investigations remain in the durable research repository. */
export class SocialResearchRuns {
  private readonly entries = new Map<string, Entry>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private closed = false;
  constructor(private readonly options: SocialResearchRunOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 180000)
      throw new ApiError(
        503,
        'SOCIAL_RUN_CONFIGURATION',
        'Research run deadlines must be between 1 and 180000 milliseconds.',
      );
    this.now = options.now ?? (() => new Date());
  }
  get activeCount(): number {
    return [...this.entries.values()].filter((entry) => !terminal(entry.run.status)).length;
  }
  start(
    inputValue: SocialResearchRunInput,
    execution: SocialResearchRun['execution'],
    executor: SocialResearchRunExecutor,
  ): SocialResearchRun {
    if (this.closed)
      throw new ApiError(
        503,
        'SOCIAL_RUN_CLOSED',
        'Research is shutting down. Start a new run after the API restarts.',
      );
    this.prune();
    if (this.activeCount >= MAX_ACTIVE)
      throw new ApiError(
        429,
        'SOCIAL_BUSY',
        'Two research runs are already running. Wait for one to finish.',
      );
    if (this.entries.size >= MAX_RETAINED) {
      const oldest = [...this.entries.values()]
        .filter((entry) => terminal(entry.run.status))
        .sort((a, b) => (a.terminalAt ?? 0) - (b.terminalAt ?? 0))[0];
      if (oldest) this.entries.delete(oldest.run.id);
    }
    const input = socialResearchRunInputSchema.parse(inputValue);
    const at = this.now().toISOString();
    const run = socialResearchRunSchema.parse({
      id: randomUUID(),
      input,
      status: 'queued',
      canCancel: true,
      execution,
      createdAt: at,
      updatedAt: at,
      investigationId: null,
      error: null,
      events: [],
      eventsTruncated: false,
      lastSequence: 0,
      artifacts: [],
    });
    const entry: Entry = {
      run,
      controller: new AbortController(),
      artifacts: new Map(),
      done: Promise.resolve(),
    };
    this.entries.set(run.id, entry);
    this.record(entry, {
      agent: 'coordinator',
      task: 'scope',
      phase: 'progress',
      message:
        execution === 'demo_replay'
          ? 'Illustrative research replay queued. No live providers or model calls will run.'
          : 'Research run queued.',
    });
    entry.done = Promise.resolve().then(() => this.execute(entry, executor));
    return structuredClone(run);
  }
  get(id: string): SocialResearchRun {
    this.prune();
    return structuredClone(this.find(id).run);
  }
  artifact(id: string, path: string): Artifact {
    this.prune();
    const valid = socialResearchArtifactPathSchema.safeParse(path);
    if (!valid.success)
      throw new ApiError(
        404,
        'SOCIAL_ARTIFACT_NOT_FOUND',
        'This public research artifact is not available.',
      );
    const artifact = this.find(id).artifacts.get(valid.data);
    if (!artifact)
      throw new ApiError(
        404,
        'SOCIAL_ARTIFACT_NOT_FOUND',
        'This public research artifact has not been created.',
      );
    return structuredClone(artifact);
  }
  cancel(id: string): SocialResearchRun {
    const entry = this.find(id);
    if (entry.committing && !terminal(entry.run.status)) {
      const message =
        'The final save has already started. Cancellation is unavailable until this atomic save finishes.';
      if (entry.run.events.at(-1)?.message !== message)
        this.record(entry, { agent: 'coordinator', task: 'persist', phase: 'progress', message });
      return structuredClone(entry.run);
    }
    if (!terminal(entry.run.status)) {
      entry.controller.abort(new Error('Canceled'));
      this.finish(entry, 'canceled', null);
    }
    return structuredClone(entry.run);
  }
  async wait(id: string): Promise<SocialResearchRun> {
    const entry = this.find(id);
    await entry.done;
    return structuredClone(entry.run);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values())
      if (!terminal(entry.run.status)) this.cancel(entry.run.id);
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
  }
  private find(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry)
      throw new ApiError(
        404,
        'SOCIAL_RUN_NOT_FOUND',
        'This research run expired or is unavailable. Saved investigations remain available in Research.',
      );
    return entry;
  }
  private prune(): void {
    const now = this.now().valueOf();
    for (const [id, entry] of this.entries)
      if (entry.terminalAt !== undefined && now - entry.terminalAt > RETENTION_MS)
        this.entries.delete(id);
  }
  private record(entry: Entry, value: SocialResearchEventInput): void {
    const event = socialResearchEventInputSchema.parse(value);
    if (event.artifactPath && !entry.artifacts.has(event.artifactPath))
      throw new ApiError(
        500,
        'SOCIAL_ARTIFACT_MISSING',
        'Research attempted to announce an artifact before it existed.',
      );
    const at = this.now().toISOString();
    entry.run.lastSequence += 1;
    entry.run.events.push({ ...event, sequence: entry.run.lastSequence, at });
    if (entry.run.events.length > MAX_EVENTS) {
      entry.run.events.shift();
      entry.run.eventsTruncated = true;
    }
    entry.run.updatedAt = at;
  }
  private finish(
    entry: Entry,
    status: 'completed' | 'failed' | 'canceled',
    error: SocialResearchRun['error'],
  ): void {
    if (terminal(entry.run.status)) return;
    entry.run.status = status;
    entry.run.canCancel = false;
    entry.run.error = error;
    entry.terminalAt = this.now().valueOf();
    this.record(entry, {
      agent: 'coordinator',
      task: status === 'completed' ? 'persist' : (entry.run.events.at(-1)?.task ?? 'scope'),
      phase: status === 'completed' ? 'completed' : 'failed',
      message:
        status === 'completed'
          ? 'Investigation saved. Evidence and script insights are ready to explore.'
          : status === 'canceled'
            ? 'Research run canceled. No additional work will be accepted.'
            : (error?.message ?? 'The research run could not finish.'),
    });
  }
  private async execute(entry: Entry, executor: SocialResearchRunExecutor): Promise<void> {
    if (terminal(entry.run.status)) return;
    entry.run.status = 'running';
    const deadline = setTimeout(
      () => entry.controller.abort(new Error('Deadline')),
      this.timeoutMs,
    );
    const signal = entry.controller.signal;
    let detach = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () =>
        reject(
          new ApiError(
            504,
            'SOCIAL_RUN_TIMEOUT',
            'The research run reached its time limit. Try a smaller search.',
          ),
        );
      signal.addEventListener('abort', onAbort, { once: true });
      detach = () => signal.removeEventListener('abort', onAbort);
    });
    const active = () => !terminal(entry.run.status) && !signal.aborted;
    try {
      const id = await Promise.race([
        executor({
          input: structuredClone(entry.run.input),
          signal,
          commit: async (operation) => {
            if (!active())
              throw new ApiError(
                408,
                'SOCIAL_RUN_CANCELED',
                'The research run was canceled before saving.',
              );
            if (entry.committing)
              throw new ApiError(
                500,
                'SOCIAL_COMMIT_STARTED',
                'The final research save has already started.',
              );
            entry.committing = true;
            entry.run.canCancel = false;
            clearTimeout(deadline);
            this.record(entry, {
              agent: 'coordinator',
              task: 'persist',
              phase: 'progress',
              message:
                'Final atomic save started. Cancellation is now unavailable; the saved result will be reported when the write finishes.',
            });
            return operation();
          },
          emit: (event) => {
            if (active()) this.record(entry, event);
          },
          writeArtifact: (pathValue, content) => {
            if (!active()) return;
            const path = socialResearchArtifactPathSchema.parse(pathValue);
            if (
              typeof content !== 'string' ||
              Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES
            )
              throw new ApiError(
                502,
                'SOCIAL_ARTIFACT_BUDGET',
                'A research artifact exceeded the public preview budget.',
              );
            if (path.endsWith('.json')) {
              try {
                JSON.parse(content);
              } catch {
                throw new ApiError(
                  502,
                  'SOCIAL_ARTIFACT_INVALID',
                  'A research artifact was not valid JSON.',
                );
              }
            }
            const artifact: Artifact = {
              path,
              content,
              bytes: Buffer.byteLength(content, 'utf8'),
              updatedAt: this.now().toISOString(),
              truncated: false,
            };
            entry.artifacts.set(path, artifact);
            entry.run.artifacts = [...entry.artifacts.values()].map(
              ({ content: _content, truncated: _truncated, ...metadata }) => metadata,
            );
            const task = path.endsWith('scope.json')
              ? 'scope'
              : path.endsWith('sources.json')
                ? 'collect'
                : path.endsWith('network.json')
                  ? 'analyze'
                  : 'brief';
            this.record(entry, {
              agent:
                task === 'collect'
                  ? 'source_researcher'
                  : task === 'analyze'
                    ? 'network_analyst'
                    : task === 'brief'
                      ? 'creative_strategist'
                      : 'coordinator',
              task,
              phase: 'progress',
              message: `Created ${path.split('/').at(-1)} as an inspectable research artifact.`,
              artifactPath: path,
            });
          },
        }),
        aborted,
      ]);
      if (!active()) return;
      entry.run.investigationId = z.uuid().parse(id);
      this.finish(entry, 'completed', null);
    } catch (error) {
      if (!terminal(entry.run.status)) {
        const safe =
          error instanceof ApiError
            ? { code: error.code.slice(0, 120), message: error.message.slice(0, 1000) }
            : {
                code: 'SOCIAL_RUN_FAILED',
                message: 'The research run could not finish. Check provider access and try again.',
              };
        this.finish(entry, 'failed', safe);
        this.options.onError?.(error);
      }
    } finally {
      clearTimeout(deadline);
      detach();
    }
  }
}
