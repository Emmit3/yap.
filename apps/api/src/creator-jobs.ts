import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import type {
  CreatorSession,
  CreatorJob,
  CreatorInput,
  CreatorAnswer,
  CreatorResearch,
  CreatorClip,
} from '@yap/contracts/creator';
import type { CreatorImageJob } from '@yap/contracts/reference-assets';
import type { Workflow } from '@yap/contracts/workflow';
import { ApiError } from './errors.js';
import { CreatorRepository } from './creator-repository.js';
import type { WorkflowRepository } from './workflow-repository.js';
import type { WorkflowAssetStore } from './workflow-assets.js';
import { type CreatorVideoProvider } from './creator-video-provider.js';
import {
  inspectCreatorClip,
  assembleCreatorClips,
  prepareCreatorVoice,
  type CreatorSoundtrack,
  type CreatorVisionAuditor,
} from './creator-media.js';
import {
  layoutVoiceover,
  voiceoverLines,
  type CreatorMusicLibrary,
  type CreatorVoiceover,
} from './creator-audio.js';
import { verifyWorkflow } from './workflow-engine.js';
import { productionProfile, productionProfiles, quoteFingerprint } from './creator-budget.js';
import {
  resolveCreatorVideoProvider,
  type CreatorVideoProviderRegistry,
} from './creator-video-factory.js';
import { resolveOutputProfile } from './creator-output-profiles.js';
import { createBrandService } from './creator-brand.js';
import {
  createSubtitleSnapshot,
  writeCreatorSubtitles,
  SUBTITLE_FILENAME,
  SUBTITLE_MAX_BYTES,
  type SubtitleWindow,
} from './creator-subtitles.js';

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
  videoProviders?: CreatorVideoProviderRegistry;
  branding?: Awaited<ReturnType<typeof createBrandService>>;
  loadStoryboard?: (
    sessionId: string,
    frameId: string,
  ) => Promise<{ record: CreatorImageJob; bytes: Buffer }>;
  auditor: CreatorVisionAuditor;
  voiceover: CreatorVoiceover;
  music: CreatorMusicLibrary;
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
  async verifySubtitles(job: CreatorJob): Promise<string> {
    if (job.kind !== 'production' || job.status !== 'succeeded' || !job.output?.subtitles)
      throw new ApiError(
        409,
        'CREATOR_SUBTITLES_NOT_READY',
        'No completed subtitles are available for this film.',
      );
    const path = join(this.work(job.id), SUBTITLE_FILENAME);
    let bytes: Buffer;
    try {
      if ((await stat(path)).size > SUBTITLE_MAX_BYTES)
        throw new ApiError(
          500,
          'CREATOR_SUBTITLES_CORRUPTED',
          'The saved subtitles failed integrity verification.',
        );
      bytes = await readFile(path);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(404, 'CREATOR_SUBTITLES_MISSING', 'The saved subtitles are missing.');
    }
    if (
      bytes.length > SUBTITLE_MAX_BYTES ||
      bytes.length !== job.output.subtitles.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== job.output.subtitles.sha256
    )
      throw new ApiError(
        500,
        'CREATOR_SUBTITLES_CORRUPTED',
        'The saved subtitles failed integrity verification.',
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
      if (
        existing.kind !== 'production' ||
        existing.approvalId !== session.approval?.id ||
        existing.quoteId !== session.approval?.quoteId
      )
        throw new ApiError(
          409,
          'CREATOR_REQUEST_CONFLICT',
          'This request belongs to another approval.',
        );
      return existing;
    }
    this.assertApproved(session, workflow);
    const quote = await this.options.repository.quote(session.approval!.quoteId!);
    if (
      quote.fingerprint !==
      quoteFingerprint(
        session,
        workflow,
        productionProfiles(this.options.video, session.plan!.clips, this.options.videoProviders),
      )
    )
      throw new ApiError(
        409,
        'CREATOR_QUOTE_STALE',
        'The plan, reference assets or provider changed. Review a new quote.',
      );
    for (const clip of session.plan!.clips)
      resolveCreatorVideoProvider(
        clip,
        this.options.video,
        this.options.videoProviders ?? new Map(),
      );
    if (session.plan?.brandSnapshot)
      await this.options.branding?.verifySnapshot(session.plan.brandSnapshot);
    if (!this.options.auditor.configured)
      throw new ApiError(
        503,
        'CREATOR_PRODUCTION_NOT_CONFIGURED',
        'Configure the selected video provider and required frame review before starting paid clips.',
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
      ...(kind === 'production'
        ? { quoteId: session.approval!.quoteId!, planId: session.plan!.id }
        : {}),
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
        const canceled = await this.options.repository.updateJob(
          saved.sessionId,
          saved.id,
          (current) => ({
            ...current,
            status: 'canceled',
            error: {
              code: 'CREATOR_CANCELED',
              message:
                'The server shut down before this job started. No provider request was submitted.',
            },
          }),
        );
        if (kind === 'production')
          await this.options.repository.releaseUnusedReservations(saved.sessionId, saved.id);
        return canceled;
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
      !session.approval.quoteId ||
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
        const quote = await this.options.repository.quote(job.quoteId!);
        const paidClips = quote.clips.filter((item) => item.costCents > 0);
        const total = plan.clips.reduce((sum, clip) => sum + clip.seconds, 0);
        const soundtrack: CreatorSoundtrack = {
          voices: [],
          // Resolved first so a missing track fails before any paid request.
          ...(plan.audio?.musicTrackId
            ? { music: this.options.music.path(plan.audio.musicTrackId) }
            : {}),
        };
        const lines = voiceoverLines(plan, workflow);
        // Validate before any paid production. Actual narration windows replace this
        // scene estimate after silence trimming and tempo placement, before buying clips.
        if (plan.subtitlesEnabled) createSubtitleSnapshot(plan, workflow);
        let narrationWindows: SubtitleWindow[] | undefined;
        if (plan.audio?.voice && lines.length > 0) {
          // Narration is recorded before any clip is generated: it is the cheapest paid step,
          // and a script that cannot fit the film must stop production before the costly ones.
          if (!job.audioReservationId || quote.narratedSegments !== lines.length)
            throw new ApiError(
              409,
              'CREATOR_QUOTE_STALE',
              'The narration is not in the approved quote. Review a new quote.',
            );
          await this.event(
            job,
            `Recording ${lines.length} narration ${lines.length === 1 ? 'line' : 'lines'}.`,
            'generating',
          );
          await this.current(session, workflow);
          signal.throwIfAborted();
          // The hold counts as used only once a line reaches the provider. Until then a
          // failure proves nothing was billed, and the whole narration hold is released.
          let started = false;
          let recorded: Buffer[];
          try {
            recorded = await this.options.voiceover.narrate(
              lines.map((line) => line.text),
              plan.audio.voice,
              workflow.brief.tone,
              signal,
              async () => {
                await this.current(session, workflow);
                signal.throwIfAborted();
                if (started) return;
                await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
                  ...current,
                  audioStarted: true,
                }));
                started = true;
              },
            );
          } catch (error) {
            // A definite rejection of the first line means the provider billed nothing.
            if (error instanceof ApiError && error.code === 'CREATOR_VOICEOVER_REJECTED')
              await this.options.repository
                .settle(job.audioReservationId, 0)
                .catch((failure) => this.options.onError?.(failure));
            throw error;
          }
          if (recorded.length !== lines.length)
            throw new ApiError(
              502,
              'CREATOR_VOICEOVER_FAILED',
              'The narration provider returned the wrong number of lines.',
            );
          const durations: number[] = [];
          for (const [index, bytes] of recorded.entries()) {
            signal.throwIfAborted();
            const source = join(directory, `voice-${index}.wav`),
              target = join(directory, `voice-${index}.pcm`);
            await writeFile(source, bytes);
            durations.push(await prepareCreatorVoice(source, target, signal));
            soundtrack.voices.push({ path: target, at: 0, tempo: 1 });
          }
          const placed = layoutVoiceover(
            lines.map((line, index) => ({ start: line.start, duration: durations[index]! })),
            total,
          );
          placed.forEach((place, index) => Object.assign(soundtrack.voices[index]!, place));
          narrationWindows = lines.map((line, index) => ({
            segmentId: line.segmentId,
            text: line.text,
            start: placed[index]!.at,
            end: placed[index]!.at + durations[index]! / placed[index]!.tempo,
          }));
        }
        const subtitles = plan.subtitlesEnabled
          ? await writeCreatorSubtitles(
              directory,
              createSubtitleSnapshot(plan, workflow, narrationWindows),
              {
                ...resolveOutputProfile(plan),
                ...(plan.brandSnapshot ? { brand: plan.brandSnapshot } : {}),
              },
            )
          : undefined;
        for (const clip of plan.clips) {
          signal.throwIfAborted();
          await this.current(session, workflow);
          const item = quote.clips.find((value) => value.clipId === clip.id);
          if (!item)
            throw new ApiError(
              409,
              'CREATOR_QUOTE_STALE',
              'This clip is not in the approved quote.',
            );
          if (item.reuse) {
            const oldJob = await this.options.repository.job(session.id, item.reuse.jobId);
            const receipt = oldJob.clips.find(
              (value) =>
                value.clipId === clip.id &&
                value.attempt === item.reuse!.attempt &&
                value.status === 'passed',
            );
            if (!receipt?.output || receipt.output.sha256 !== item.reuse.sha256)
              throw new ApiError(
                409,
                'CREATOR_REUSE_STALE',
                'A previously reviewed clip changed. Request a new quote.',
              );
            const path = this.clipPath(job.id, clip.id, item.reuse.attempt);
            await copyFile(await this.verifyClip(oldJob, clip.id, item.reuse.attempt), path);
            accepted.push(path);
            await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
              ...current,
              clips: [...current.clips, receipt],
            }));
            continue;
          }
          const number = item.attempt;
          const reservationId =
            job.reservationIds?.[paidClips.findIndex((value) => value.clipId === clip.id)];
          if (!reservationId)
            throw new ApiError(
              409,
              'CREATOR_RESERVATION_REQUIRED',
              'No spending reservation exists for this clip.',
            );
          const asset = workflow.assets.find((value) => value.id === clip.assetId);
          let image = asset ? await this.options.assets.load(workflow.id, asset) : undefined;
          if (clip.storyboardFrameId) {
            if (!this.options.loadStoryboard || clip.assetId)
              throw new ApiError(
                409,
                'CREATOR_IMAGE_SOURCE',
                'Choose one verified image source for this shot.',
              );
            const frame = await this.options.loadStoryboard(session.id, clip.storyboardFrameId);
            if (
              !clip.storyboardFrameSha256 ||
              frame.record.output?.sha256 !== clip.storyboardFrameSha256
            )
              throw new ApiError(
                409,
                'CREATOR_IMAGE_SOURCE_CHANGED',
                'The storyboard source changed. Review a new quote.',
              );
            image = frame.bytes;
          }
          const video = resolveCreatorVideoProvider(
            clip,
            this.options.video,
            this.options.videoProviders ?? new Map(),
          );
          await this.current(session, workflow);
          signal.throwIfAborted();
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
                prompt: clip.prompt,
                reservationId,
                ...(clip.videoProfileId
                  ? {
                      provider: item.provider,
                      model: item.model,
                      videoProfileId: clip.videoProfileId,
                      ratio: item.ratio,
                      nativeWidth: item.nativeWidth,
                      nativeHeight: item.nativeHeight,
                    }
                  : {}),
              },
            ],
          }));
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
          await this.event(
            job,
            'Started clip ' +
              (plan.clips.indexOf(clip) + 1) +
              '/' +
              plan.clips.length +
              ', approved paid attempt ' +
              number +
              '/2.',
            'generating',
          );
          await this.current(session, workflow);
          signal.throwIfAborted();
          const bytes = await video.generate({
            clip,
            ...(image ? { image } : {}),
            signal,
            beforeSubmit: async () => {
              await this.current(session, workflow);
              signal.throwIfAborted();
            },
            onSubmitted: async (id) => {
              await update((receipt) => ({ ...receipt, providerTaskId: id }));
            },
          });
          signal.throwIfAborted();
          const path = this.clipPath(job.id, clip.id, number);
          await writeFile(path, bytes);
          await update((receipt) => ({ ...receipt, status: 'auditing' }));
          await this.event(
            job,
            'Inspecting decoded video and frames for clip ' + (plan.clips.indexOf(clip) + 1) + '.',
            'auditing',
          );
          const technical = await inspectCreatorClip(path, clip, signal, video.profile);
          let audit = technical.audit;
          if (technical.audit.technicalPassed) {
            await this.current(session, workflow);
            signal.throwIfAborted();
            audit = await this.options.auditor.audit(
              clip,
              technical.frames,
              image,
              signal,
              async () => {
                await this.current(session, workflow);
                signal.throwIfAborted();
              },
            );
          }
          const passed = audit.technicalPassed && audit.visionPassed === true;
          await update((receipt) => ({
            ...receipt,
            status: passed ? 'passed' : 'failed',
            audit,
            output: {
              bytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          }));
          if (!passed)
            throw new ApiError(
              422,
              'CREATOR_CLIP_AUDIT_FAILED',
              'A clip failed review. No automatic paid retry was made. Request a new quote and explicitly approve another attempt.',
            );
          accepted.push(path);
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
          soundtrack,
          Boolean(subtitles),
          {
            ...resolveOutputProfile(plan),
            ...(plan.brandSnapshot
              ? {
                  brand: await this.options.branding!.verifySnapshot(plan.brandSnapshot),
                  ...(plan.brandSnapshot.logo
                    ? { logoPath: this.options.branding!.logoPath(plan.brandSnapshot.logo) }
                    : {}),
                }
              : {}),
          },
        );
        if (output.hasAudio !== plan.hasAudio)
          throw new ApiError(
            502,
            'CREATOR_ASSEMBLY_VERIFICATION',
            'The assembled film does not have the approved soundtrack.',
          );
        await this.current(session, workflow);
        signal.throwIfAborted();
        await this.options.repository.updateJob(job.sessionId, job.id, (current) => ({
          ...current,
          output: {
            ...output,
            outputProfileId: resolveOutputProfile(plan).id,
            resized:
              resolveOutputProfile(plan).resized ||
              plan.clips.some((clip) => {
                const source = resolveCreatorVideoProvider(
                  clip,
                  this.options.video,
                  this.options.videoProviders ?? new Map(),
                ).profile;
                return (
                  !clip.videoProfileId ||
                  source?.nativeWidth !== output.width ||
                  source?.nativeHeight !== output.height
                );
              }),
            ...(subtitles ? { subtitles } : {}),
          },
        }));
        const sound =
          soundtrack.voices.length > 0
            ? soundtrack.music
              ? 'with narration and music'
              : 'with narration'
            : soundtrack.music
              ? 'with music'
              : 'without sound';
        await this.event(
          job,
          `Saved the final MP4 ${sound}. Sampled-frame review does not establish product facts or inspect every frame.`,
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
    } finally {
      if (job.kind === 'production')
        await this.options.repository
          .releaseUnusedReservations(job.sessionId, job.id)
          .catch((error) => this.options.onError?.(error));
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
