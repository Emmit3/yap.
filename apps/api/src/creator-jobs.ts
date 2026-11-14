import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import type {
  CreatorSession,
  CreatorJob,
  CreatorInput,
  CreatorAnswer,
  CreatorResearch,
} from '@yap/contracts/creator';
import type { Workflow } from '@yap/contracts/workflow';
import { ApiError } from './errors.js';
import { CreatorRepository } from './creator-repository.js';
import type { WorkflowRepository } from './workflow-repository.js';
import type { WorkflowAssetStore } from './workflow-assets.js';
import { creatorVideoPrompt, type CreatorVideoProvider } from './creator-video-provider.js';
import {
  inspectCreatorClip,
  assembleCreatorClips,
  type CreatorVisionAuditor,
} from './creator-media.js';
import { verifyWorkflow } from './workflow-engine.js';

export type CreatorAnalyzer = (
  input: CreatorInput,
  answers: CreatorAnswer[],
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
) => Promise<CreatorResearch>;
export interface CreatorJobsOptions {
  repository: CreatorRepository;
  workflows: WorkflowRepository;
  assets: WorkflowAssetStore;
  directory: string;
  analyze: CreatorAnalyzer;
  video: CreatorVideoProvider;
  auditor: CreatorVisionAuditor;
  onError?: (error: unknown) => void;
}
const terminal = (job: CreatorJob) =>
  job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled';
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new ApiError(409, 'CREATOR_CANCELED', 'Creation was canceled.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** Durable receipts and bounded local workers. Restart never replays a billable POST. */
export class CreatorJobs {
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closed = false;
  private productionReserved = false;
  private starting = 0;
  private startingRequests = new Map<string, Promise<CreatorJob>>();
  private admissionWaiters = new Set<() => void>();
  constructor(private readonly options: CreatorJobsOptions) {}
  path(jobId: string): string {
    return this.child(`${jobId}.mp4`);
  }
  private child(name: string): string {
    const parent = resolve(this.options.directory),
      target = resolve(parent, name),
      within = relative(parent, target);
    if (!within || within.startsWith('..') || isAbsolute(within))
      throw new Error('Invalid creator output path.');
    return target;
  }
  private work(jobId: string): string {
    return this.child(jobId);
  }
  clipPath(jobId: string, clipId: string, attempt: number): string {
    return join(this.work(jobId), `${clipId}-${attempt}.mp4`);
  }
  async verifyOutput(job: CreatorJob): Promise<string> {
    if (job.status !== 'succeeded' || !job.output)
      throw new ApiError(409, 'CREATOR_VIDEO_NOT_READY', 'The audited video is not ready.');
    const path = this.path(job.id);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new ApiError(404, 'CREATOR_VIDEO_MISSING', 'The saved video is missing.');
    }
    if (
      bytes.length !== job.output.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== job.output.sha256
    )
      throw new ApiError(
        500,
        'CREATOR_VIDEO_CORRUPTED',
        'The saved video failed integrity verification.',
      );
    return path;
  }
  async verifyClip(job: CreatorJob, clipId: string, attempt: number): Promise<string> {
    const receipt = job.clips.find(
      (item) => item.clipId === clipId && item.attempt === attempt && item.status === 'passed',
    );
    if (!receipt?.output)
      throw new ApiError(409, 'CREATOR_CLIP_NOT_READY', 'This clip has not passed review.');
    const path = this.clipPath(job.id, clipId, attempt);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new ApiError(404, 'CREATOR_CLIP_MISSING', 'The reviewed clip file is missing.');
    }
    if (
      bytes.length !== receipt.output.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== receipt.output.sha256
    )
      throw new ApiError(500, 'CREATOR_CLIP_CORRUPTED', 'This clip changed after review.');
    return path;
  }
  async startAnalysis(session: CreatorSession, workflow: Workflow): Promise<CreatorJob> {
    return this.start(session, workflow, 'analysis', randomUUID());
  }
  async startProduction(
    session: CreatorSession,
    workflow: Workflow,
    requestId: string,
  ): Promise<CreatorJob> {
    const existing = (await this.options.repository.jobs(session.id)).find(
      (job) => job.requestId === requestId,
    );
    if (existing) {
      if (existing.kind !== 'production' || existing.approvalId !== session.approval?.id)
        throw new ApiError(
          409,
          'CREATOR_REQUEST_CONFLICT',
          'This request belongs to another approval.',
        );
      return existing;
    }
    this.assertApproved(session, workflow);
    if (!this.options.video.configured || !this.options.auditor.configured)
      throw new ApiError(
        503,
        'CREATOR_PRODUCTION_NOT_CONFIGURED',
        'Configure RUNWAYML_API_SECRET and OPENAI_API_KEY before starting paid clips.',
      );
    const key = `${session.id}:${requestId}`,
      pending = this.startingRequests.get(key);
    if (pending) return pending;
    const started = this.start(session, workflow, 'production', requestId);
    this.startingRequests.set(key, started);
    try {
      return await started;
    } finally {
      this.startingRequests.delete(key);
    }
  }
  private async start(
    session: CreatorSession,
    workflow: Workflow,
    kind: CreatorJob['kind'],
    requestId: string,
  ): Promise<CreatorJob> {
    if (this.closed) throw new ApiError(503, 'CREATOR_CLOSED', 'Creation is shutting down.');
    if (this.active.size + this.starting >= 3 || (kind === 'production' && this.productionReserved))
      throw new ApiError(
        429,
        'CREATOR_BUSY',
        'The creator workers are busy. Wait for a current job to finish.',
      );
    // Reserve synchronously before the first awaited storage operation, across all sessions.
    this.starting++;
    if (kind === 'production') this.productionReserved = true;
    const now = new Date().toISOString();
    const job: CreatorJob = {
      id: randomUUID(),
      requestId,
      sessionId: session.id,
      kind,
      status: 'queued',
      phase: 'queued',
      sourceVersion: session.version,
      workflowVersion: workflow.version,
      approvalId: kind === 'production' ? (session.approval?.id ?? null) : null,
      clips: [],
      events: [],
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const saved = await this.options.repository.addJob(job, session.version);
      if (saved.id !== job.id) {
        if (kind === 'production') this.productionReserved = false;
        return saved;
      }
      if (this.closed) {
        if (kind === 'production') this.productionReserved = false;
        return this.options.repository.updateJob(saved.sessionId, saved.id, (current) => ({
          ...current,
          status: 'canceled',
          error: {
            code: 'CREATOR_CANCELED',
            message:
              'The server shut down before this job started. No provider request was submitted.',
          },
        }));
      }
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() => this.execute(saved, session, workflow, controller.signal))
        .finally(() => {
          this.active.delete(saved.id);
          if (kind === 'production') this.productionReserved = false;
        });
      this.active.set(saved.id, { controller, done });
      return saved;
    } catch (error) {
      if (kind === 'production') this.productionReserved = false;
      throw error;
    } finally {
      this.starting--;
      if (this.starting === 0) {
        for (const resolve of this.admissionWaiters) resolve();
        this.admissionWaiters.clear();
      }
    }
  }
  private async event(
    job: CreatorJob,
    message: string,
    phase?: CreatorJob['phase'],
  ): Promise<void> {
    await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
      ...current,
      ...(phase ? { phase } : {}),
      events: [
        ...current.events,
        { at: new Date().toISOString(), message: message.slice(0, 1000) },
      ].slice(-100),
    }));
  }
  private async current(session: CreatorSession, workflow: Workflow): Promise<void> {
    const latest = await this.options.repository.get(session.id),
      source = await this.options.workflows.get(workflow.id);
    if (latest.version !== session.version || source.version !== workflow.version)
      throw new ApiError(
        409,
        'CREATOR_SOURCE_CHANGED',
        'The approved creation changed during production. No further clips were started.',
      );
    this.assertApproved(latest, source);
  }
  private assertApproved(session: CreatorSession, workflow: Workflow): void {
    if (
      !session.plan ||
      !session.approval ||
      session.approval.planId !== session.plan.id ||
      session.approval.workflowVersion !== workflow.version ||
      session.plan.workflowVersion !== workflow.version ||
      session.plan.scriptId !== workflow.script?.id ||
      session.plan.sourceScenesId !== workflow.scenes?.id ||
      Object.values(verifyWorkflow(workflow)).some((report) => report.state !== 'approved')
    )
      throw new ApiError(
        409,
        'CREATOR_APPROVAL_REQUIRED',
        'Review and explicitly approve the current script, clip plan and paid attempt budget.',
      );
  }
  private async execute(
    job: CreatorJob,
    session: CreatorSession,
    workflow: Workflow,
    external: AbortSignal,
  ): Promise<void> {
    const signal = AbortSignal.any([
      external,
      AbortSignal.timeout(job.kind === 'analysis' ? 180000 : 30 * 60 * 1000),
    ]);
    try {
      signal.throwIfAborted();
      await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
        ...current,
        status: 'running',
      }));
      if (job.kind === 'analysis') {
        await this.event(job, 'Started bounded source and cinematography research.', 'research');
        const events: Promise<void>[] = [];
        const research = await abortable(
          this.options.analyze(session.input, session.answers, signal, (message) => {
            if (signal.aborted) return;
            const write = this.event(job, message);
            events.push(write);
            write.catch(() => undefined);
          }),
          signal,
        );
        await Promise.all(events);
        signal.throwIfAborted();
        await this.options.repository.withSession(session.id, async () => {
          let applied = false;
          for (let retry = 0; retry < 3 && !applied; retry++) {
            const latest = await this.options.repository.get(session.id);
            if (JSON.stringify(latest.input) !== JSON.stringify(session.input))
              throw new ApiError(
                409,
                'CREATOR_ANALYSIS_STALE',
                'Your source input changed while research ran. The older result was not applied; run research again.',
              );
            const answersChanged =
              JSON.stringify(latest.answers) !== JSON.stringify(session.answers);
            const result = answersChanged
              ? {
                  ...research,
                  limitations: [
                    ...research.limitations.slice(0, 19),
                    'Sources were collected before your later interview answers. Saved answers and any newer clip plan were preserved.',
                  ],
                }
              : research;
            try {
              await this.options.repository.update(session.id, latest.version, (current) => {
                signal.throwIfAborted();
                const preserveSelected = current.selectedReferenceIds.length > 0;
                const nextResearch =
                  preserveSelected && current.research
                    ? {
                        ...result,
                        sources: [
                          ...current.research.sources,
                          ...result.sources.filter(
                            (source) =>
                              !current.research!.sources.some((old) => old.id === source.id),
                          ),
                        ].slice(0, 40),
                        references: [
                          ...current.research.references,
                          ...result.references.filter(
                            (reference) =>
                              !current.research!.references.some((old) => old.id === reference.id),
                          ),
                        ].slice(0, 12),
                      }
                    : result;
                return { ...current, research: nextResearch };
              });
              applied = true;
            } catch (error) {
              if (!(error instanceof ApiError && error.code === 'CREATOR_VERSION_CONFLICT'))
                throw error;
            }
          }
          if (!applied)
            throw new ApiError(
              409,
              'CREATOR_ANALYSIS_STALE',
              'This creation kept changing while research was saved. Run research again.',
            );
        });
        await this.event(
          job,
          'Research saved with source citations and coverage limits.',
          'complete',
        );
      } else {
        await this.current(session, workflow);
        const plan = session.plan!;
        const directory = this.work(job.id);
        await mkdir(directory, { recursive: true });
        const accepted: string[] = [];
        const history = (await this.options.repository.jobs(session.id)).filter(
          (item) => item.approvalId === job.approvalId && item.id !== job.id,
        );
        for (const clip of plan.clips) {
          signal.throwIfAborted();
          await this.current(session, workflow);
          const previous = history.flatMap((item) =>
            item.clips
              .filter((receipt) => receipt.clipId === clip.id)
              .map((receipt) => ({ job: item, receipt })),
          );
          const passed = previous.find((item) => item.receipt.status === 'passed');
          if (passed) {
            const oldPath = await this.verifyClip(passed.job, clip.id, passed.receipt.attempt),
              path = this.clipPath(job.id, clip.id, passed.receipt.attempt);
            await copyFile(oldPath, path);
            accepted.push(path);
            await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
              ...current,
              clips: [...current.clips, passed.receipt],
            }));
            continue;
          }
          let attempt = previous.reduce((max, item) => Math.max(max, item.receipt.attempt), 0),
            success = false;
          const asset = workflow.assets.find((item) => item.id === clip.assetId),
            image = asset ? await this.options.assets.load(workflow.id, asset) : undefined;
          let correction = '';
          while (attempt < plan.maxAttemptsPerClip) {
            const available = 1000 - creatorVideoPrompt({ ...clip, prompt: '' }).length;
            if (correction && available < 80)
              throw new ApiError(
                400,
                'CREATOR_CORRECTION_LIMIT',
                'The approved camera and lighting text leaves too little room for an audit correction. Shorten those parameters and review a new plan. No correction attempt was submitted.',
              );
            const generatedClip = correction
              ? {
                  ...clip,
                  prompt:
                    `${clip.prompt.slice(0, Math.floor(available * 0.55))} Correct these visible issues: ${correction.slice(0, Math.max(1, available - Math.floor(available * 0.55) - 30))}`.slice(
                      0,
                      available,
                    ),
                }
              : clip;
            if (creatorVideoPrompt(generatedClip).length > 1000)
              throw new ApiError(
                400,
                'CREATOR_PROMPT_TOO_LONG',
                'The corrected shot exceeds the provider prompt limit. No correction attempt was submitted.',
              );
            await this.current(session, workflow);
            signal.throwIfAborted();
            attempt++;
            const number = attempt;
            // Persist a paid-attempt reservation before the provider POST, including unknown outcomes.
            await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
              ...current,
              phase: 'generating',
              clips: [
                ...current.clips,
                {
                  clipId: clip.id,
                  attempt: number,
                  providerTaskId: null,
                  status: 'generating',
                  audit: null,
                  prompt: generatedClip.prompt,
                },
              ],
            }));
            await this.event(
              job,
              `Started clip ${plan.clips.indexOf(clip) + 1}/${plan.clips.length}, paid attempt ${number}/${plan.maxAttemptsPerClip}.`,
              'generating',
            );
            const update = async (
              change: (receipt: CreatorJob['clips'][number]) => CreatorJob['clips'][number],
            ) => {
              await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
                ...current,
                clips: current.clips.map((receipt) =>
                  receipt.clipId === clip.id && receipt.attempt === number
                    ? change(receipt)
                    : receipt,
                ),
              }));
            };
            const bytes = await abortable(
              this.options.video.generate({
                clip: generatedClip,
                ...(image ? { image } : {}),
                signal,
                onSubmitted: async (id) => {
                  signal.throwIfAborted();
                  await update((receipt) => ({ ...receipt, providerTaskId: id }));
                },
              }),
              signal,
            );
            const path = this.clipPath(job.id, clip.id, number);
            await writeFile(path, bytes);
            await update((receipt) => ({ ...receipt, status: 'auditing' }));
            await this.event(
              job,
              `Inspecting decoded video and generated frames for clip ${plan.clips.indexOf(clip) + 1}.`,
              'auditing',
            );
            const technical = await inspectCreatorClip(path, clip, signal);
            const audit = technical.audit.technicalPassed
              ? await abortable(
                  this.options.auditor.audit(clip, technical.frames, image, signal),
                  signal,
                )
              : technical.audit;
            const passedAudit = audit.technicalPassed && audit.visionPassed === true;
            await update((receipt) => ({
              ...receipt,
              status: passedAudit ? 'passed' : 'failed',
              audit,
              output: {
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              },
            }));
            if (passedAudit) {
              accepted.push(path);
              success = true;
              break;
            }
            await this.event(
              job,
              `Clip ${plan.clips.indexOf(clip) + 1} failed review: ${audit.summary}`,
              'auditing',
            );
            correction = audit.issues.join('; ') || audit.summary;
            signal.throwIfAborted();
            await this.current(session, workflow);
          }
          if (!success)
            throw new ApiError(
              422,
              'CREATOR_CLIP_AUDIT_FAILED',
              'A clip failed the allowed technical/visual review attempts. No unchecked final video was published.',
            );
        }
        signal.throwIfAborted();
        await this.current(session, workflow);
        await this.event(
          job,
          'Assembling the clips that passed technical and sampled-frame review.',
          'assembling',
        );
        const output = await assembleCreatorClips(
          accepted,
          this.path(job.id),
          directory,
          plan.clips.map((clip) => clip.seconds),
          signal,
        );
        await this.current(session, workflow);
        signal.throwIfAborted();
        await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
          ...current,
          output,
        }));
        await this.event(
          job,
          'Saved the silent final MP4. Sampled-frame review does not establish product facts or inspect every frame.',
          'complete',
        );
      }
      signal.throwIfAborted();
      await this.options.repository.updateJob(job.sessionId, job.id, (current) =>
        terminal(current) ? current : { ...current, status: 'succeeded', phase: 'complete' },
      );
    } catch (error) {
      const canceled = external.aborted,
        known = error instanceof ApiError;
      await this.options.repository
        .updateJob(job.sessionId, job.id, (current) => ({
          ...current,
          status: canceled ? 'canceled' : 'failed',
          output: null,
          error: {
            code: canceled
              ? 'CREATOR_CANCELED'
              : known
                ? error.code
                : signal.aborted
                  ? 'CREATOR_TIMEOUT'
                  : 'CREATOR_JOB_FAILED',
            message: canceled
              ? 'Canceled locally. A submitted provider task may continue and be billed.'
              : known
                ? error.message
                : signal.aborted
                  ? 'Creation exceeded its deadline. A submitted provider task may still be billed; it was not automatically repeated.'
                  : 'Creation failed. No paid request was automatically repeated.',
          },
        }))
        .catch((failure) => this.options.onError?.(failure));
      if (job.kind === 'production')
        await rm(this.path(job.id), { force: true }).catch(() => undefined);
      if (!known && !signal.aborted) this.options.onError?.(error);
    }
  }
  async cancel(sessionId: string, id: string): Promise<CreatorJob> {
    const job = await this.options.repository.job(sessionId, id);
    if (terminal(job)) return job;
    this.active.get(id)?.controller.abort();
    return this.options.repository.updateJob(sessionId, id, (current) => ({
      ...current,
      status: 'canceled',
      output: null,
      error: {
        code: 'CREATOR_CANCELED',
        message: 'Canceled locally. Submitted provider work may continue and be billed.',
      },
    }));
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.starting > 0) await new Promise<void>((resolve) => this.admissionWaiters.add(resolve));
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled([...this.active.values()].map((entry) => entry.done));
  }
}
