import { randomUUID } from 'node:crypto';
import type {
  CreatorImageJob,
  CreatorImageQuote,
  CreatorImageQuoteRequest,
  CreatorImageSettings,
  CreatorImageStart,
  CreatorImageVariant,
} from '@yap/contracts/creator-images';
import type { CreatorSession } from '@yap/contracts/creator';
import type { Workflow, WorkflowImageAsset } from '@yap/contracts/workflow';
import { ApiError } from './errors.js';
import type { CreatorImageProvider, CreatorImageUsage } from './creator-image-provider.js';
import { CreatorRepository } from './creator-repository.js';
import type { WorkflowRepository } from './workflow-repository.js';
import { WorkflowAssetStore } from './workflow-assets.js';

export interface CreatorImageJobsOptions {
  repository: CreatorRepository;
  workflows: WorkflowRepository;
  assets: WorkflowAssetStore;
  imageDirectory: string;
  provider: CreatorImageProvider;
  onError?: (error: unknown) => void;
}
const terminal = (job: CreatorImageJob) =>
  job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled';

/** Image candidates have their own immutable library and never mutate an approved film. */
export class CreatorImageJobs {
  private readonly generated: WorkflowAssetStore;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly starting = new Map<string, Promise<CreatorImageJob>>();
  private slots = 0;
  private closed = false;
  constructor(private readonly options: CreatorImageJobsOptions) {
    this.generated = new WorkflowAssetStore(options.imageDirectory);
  }
  async load(sessionId: string, variantId: string): Promise<Buffer> {
    const variant = await this.options.repository.imageVariant(sessionId, variantId);
    return this.generated.load(sessionId, variant.media);
  }
  private checkClip(settings: CreatorImageSettings, session: CreatorSession): void {
    if (settings.clipId && !session.plan?.clips.some((clip) => clip.id === settings.clipId))
      throw new ApiError(
        409,
        'CREATOR_IMAGE_CLIP_STALE',
        'Choose a shot in the current saved plan.',
      );
  }
  private async context(sessionId: string, version: number, workflowVersion: number) {
    const session = await this.options.repository.get(sessionId);
    this.options.repository.checkVersion(session, version);
    const workflow = await this.options.workflows.get(session.workflowId);
    if (workflow.version !== workflowVersion)
      throw new ApiError(
        409,
        'CREATOR_IMAGE_SOURCE_CHANGED',
        'The film changed. Review a new image quote.',
      );
    return { session, workflow };
  }
  private async source(
    settings: CreatorImageSettings,
    session: CreatorSession,
    workflow: Workflow,
  ) {
    if (settings.parentVariantId) {
      const variant = await this.options.repository.imageVariant(
        session.id,
        settings.parentVariantId,
      );
      return {
        bytes: await this.generated.load(session.id, variant.media),
        sha256: variant.media.sha256,
      };
    }
    if (settings.sourceAssetId) {
      const asset = workflow.assets.find((item) => item.id === settings.sourceAssetId);
      if (!asset)
        throw new ApiError(
          409,
          'CREATOR_IMAGE_SOURCE_MISSING',
          'The uploaded source photo is no longer available.',
        );
      return { bytes: await this.options.assets.load(workflow.id, asset), sha256: asset.sha256 };
    }
    return { bytes: undefined, sha256: null };
  }
  async quote(sessionId: string, input: CreatorImageQuoteRequest): Promise<CreatorImageQuote> {
    if (!this.options.provider.configured)
      throw new ApiError(
        503,
        'CREATOR_IMAGE_NOT_CONFIGURED',
        'Set OPENAI_API_KEY to generate image candidates.',
      );
    return this.options.repository.withSession(sessionId, async () => {
      const { session, workflow } = await this.context(
        sessionId,
        input.expectedVersion,
        input.expectedWorkflowVersion,
      );
      this.checkClip(input.settings, session);
      const source = await this.source(input.settings, session, workflow);
      const now = new Date();
      return this.options.repository.addImageQuote({
        id: randomUUID(),
        sessionId,
        sessionVersion: session.version,
        workflowVersion: workflow.version,
        settings: input.settings,
        sourceSha256: source.sha256,
        // Conservative app estimate for one bounded image, not a provider invoice guarantee.
        maxCostCents: 200,
        currency: 'USD',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
        consumedByJobId: null,
      });
    });
  }
  async start(sessionId: string, input: CreatorImageStart): Promise<CreatorImageJob> {
    const existing = (await this.options.repository.imageJobs(sessionId)).find(
      (job) => job.requestId === input.requestId,
    );
    if (existing) {
      if (existing.quoteId !== input.quoteId)
        throw new ApiError(
          409,
          'CREATOR_IMAGE_REQUEST_CONFLICT',
          'This request ID belongs to another image quote.',
        );
      return existing;
    }
    const key = `${sessionId}:${input.requestId}`;
    const pending = this.starting.get(key);
    if (pending) {
      const started = await pending;
      if (started.quoteId !== input.quoteId)
        throw new ApiError(
          409,
          'CREATOR_IMAGE_REQUEST_CONFLICT',
          'This request ID belongs to another image quote.',
        );
      return started;
    }
    const started = this.startNew(sessionId, input);
    this.starting.set(key, started);
    try {
      return await started;
    } finally {
      this.starting.delete(key);
    }
  }
  private async startNew(sessionId: string, input: CreatorImageStart): Promise<CreatorImageJob> {
    if (this.closed)
      throw new ApiError(503, 'CREATOR_IMAGE_CLOSED', 'Image creation is shutting down.');
    if (this.slots >= 2)
      throw new ApiError(
        429,
        'CREATOR_IMAGE_BUSY',
        'Image workers are busy. Wait for a current image to finish.',
      );
    if (!this.options.provider.configured)
      throw new ApiError(
        503,
        'CREATOR_IMAGE_NOT_CONFIGURED',
        'Set OPENAI_API_KEY to generate image candidates.',
      );
    this.slots++;
    let running = false;
    try {
      const candidateId = randomUUID();
      const saved = await this.options.repository.withSession(sessionId, async () => {
        const { session, workflow } = await this.context(
          sessionId,
          input.expectedVersion,
          input.expectedWorkflowVersion,
        );
        const quote = await this.options.repository.imageQuote(sessionId, input.quoteId);
        if (quote.sessionVersion !== session.version || quote.workflowVersion !== workflow.version)
          throw new ApiError(
            409,
            'CREATOR_IMAGE_QUOTE_STALE',
            'Review a current image quote for this film.',
          );
        this.checkClip(quote.settings, session);
        const source = await this.source(quote.settings, session, workflow);
        if (source.sha256 !== quote.sourceSha256)
          throw new ApiError(
            409,
            'CREATOR_IMAGE_SOURCE_CHANGED',
            'The image reference changed. Review a new quote.',
          );
        const now = new Date().toISOString();
        return this.options.repository.addImageJob(
          {
            id: candidateId,
            sessionId,
            requestId: input.requestId,
            quoteId: quote.id,
            sourceVersion: session.version,
            workflowVersion: workflow.version,
            settings: quote.settings,
            status: 'queued',
            maxCostCents: quote.maxCostCents,
            submittedAt: null,
            variantId: null,
            error: null,
            createdAt: now,
            updatedAt: now,
          },
          session.version,
        );
      });
      if (saved.id !== candidateId) return saved;
      if (this.closed) {
        const canceled = await this.options.repository.updateImageJob(
          sessionId,
          saved.id,
          (job) => ({
            ...job,
            status: 'canceled',
            error: {
              code: 'CREATOR_CANCELED',
              message: 'Image creation stopped before submission.',
            },
          }),
        );
        await this.options.repository.settle(saved.reservationId, 0);
        return canceled;
      }
      const controller = new AbortController();
      const done = Promise.resolve()
        .then(() => this.execute(saved, controller.signal))
        .finally(() => {
          this.active.delete(saved.id);
          this.slots--;
        });
      this.active.set(saved.id, { controller, done });
      running = true;
      return saved;
    } finally {
      if (!running) this.slots--;
    }
  }
  private async settleUsage(
    job: CreatorImageJob,
    usage: CreatorImageUsage | undefined,
  ): Promise<void> {
    if (
      !usage ||
      ![usage.textInputTokens, usage.imageInputTokens, usage.outputTokens].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      return;
    const cents = Math.ceil(
      (usage.textInputTokens * 500 + usage.imageInputTokens * 800 + usage.outputTokens * 3000) /
        1_000_000,
    );
    if (Number.isSafeInteger(cents) && cents > job.maxCostCents) {
      await this.options.repository.recordImageCostOverrun(job.sessionId, job.id, cents);
      return;
    }
    if (Number.isSafeInteger(cents) && cents >= 0 && cents <= job.maxCostCents)
      await this.options.repository
        .settle(job.reservationId, cents)
        .catch(this.options.onError ?? (() => undefined));
  }
  private async execute(job: CreatorImageJob, signal: AbortSignal): Promise<void> {
    let stored: WorkflowImageAsset | undefined;
    try {
      signal.throwIfAborted();
      await this.options.repository.updateImageJob(job.sessionId, job.id, (current) => {
        if (terminal(current))
          throw new ApiError(409, 'CREATOR_CANCELED', 'Image creation was canceled.');
        return { ...current, status: 'running' };
      });
      const quote = await this.options.repository.imageQuote(job.sessionId, job.quoteId);
      const { session, workflow } = await this.context(
        job.sessionId,
        job.sourceVersion,
        job.workflowVersion,
      );
      const source = await this.source(job.settings, session, workflow);
      const result = await this.options.provider.generate({
        settings: job.settings,
        ...(source.bytes ? { image: source.bytes } : {}),
        signal,
        beforeSubmit: () =>
          this.options.repository.withSession(job.sessionId, async () => {
            signal.throwIfAborted();
            const budget = await this.options.repository.budget();
            if (budget.pausedReason)
              throw new ApiError(409, 'CREATOR_BUDGET_PAUSED', budget.pausedReason);
            const latest = await this.context(
              job.sessionId,
              job.sourceVersion,
              job.workflowVersion,
            );
            this.checkClip(job.settings, latest.session);
            const checkedSource = await this.source(job.settings, latest.session, latest.workflow);
            if (checkedSource.sha256 !== quote.sourceSha256)
              throw new ApiError(
                409,
                'CREATOR_IMAGE_SOURCE_CHANGED',
                'The image reference changed before submission.',
              );
            signal.throwIfAborted();
            await this.options.repository.updateImageJob(job.sessionId, job.id, (current) => {
              if (current.status !== 'running' || current.submittedAt)
                throw new ApiError(
                  409,
                  'CREATOR_IMAGE_JOB_CHANGED',
                  'This image request can no longer be submitted.',
                );
              return { ...current, submittedAt: new Date().toISOString() };
            });
          }),
      });
      await this.settleUsage(job, result.usage);
      signal.throwIfAborted();
      stored = await this.generated.upload(
        job.sessionId,
        result.bytes,
        result.mimeType,
        `generated-${job.id}.${result.mimeType === 'image/png' ? 'png' : result.mimeType === 'image/jpeg' ? 'jpg' : 'webp'}`,
      );
      signal.throwIfAborted();
      const variant: CreatorImageVariant = {
        id: stored.id,
        sessionId: job.sessionId,
        jobId: job.id,
        kind: job.settings.parentVariantId || job.settings.sourceAssetId ? 'edited' : 'generated',
        settings: job.settings,
        sourceSha256: quote.sourceSha256,
        media: stored,
        createdAt: new Date().toISOString(),
      };
      await this.options.repository.completeImageJob(job.sessionId, job.id, variant);
      stored = undefined;
    } catch (error) {
      if (stored)
        await this.generated
          .remove(job.sessionId, stored)
          .catch(this.options.onError ?? (() => undefined));
      try {
        const current = await this.options.repository.imageJob(job.sessionId, job.id);
        if (
          !current.submittedAt ||
          (error instanceof ApiError && error.code === 'CREATOR_IMAGE_REJECTED')
        )
          await this.options.repository
            .settle(job.reservationId, 0)
            .catch(this.options.onError ?? (() => undefined));
        if (!terminal(current))
          await this.options.repository.updateImageJob(job.sessionId, job.id, (value) => ({
            ...value,
            status: signal.aborted ? 'canceled' : 'failed',
            error: signal.aborted
              ? {
                  code: 'CREATOR_CANCELED',
                  message: 'Canceled locally. Submitted image work may still be billed.',
                }
              : error instanceof ApiError
                ? { code: error.code, message: error.message }
                : {
                    code: 'CREATOR_IMAGE_FAILED',
                    message: 'The image request did not complete. No paid request was repeated.',
                  },
          }));
      } catch (saveError) {
        this.options.onError?.(saveError);
      }
    }
  }
  async cancel(sessionId: string, jobId: string): Promise<CreatorImageJob> {
    const current = await this.options.repository.imageJob(sessionId, jobId);
    if (terminal(current)) return current;
    this.active.get(jobId)?.controller.abort();
    const canceled = await this.options.repository.updateImageJob(sessionId, jobId, (job) =>
      terminal(job)
        ? job
        : {
            ...job,
            status: 'canceled',
            error: {
              code: 'CREATOR_CANCELED',
              message: 'Canceled locally. Submitted image work may still be billed.',
            },
          },
    );
    if (!canceled.submittedAt) await this.options.repository.settle(canceled.reservationId, 0);
    return canceled;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.starting.values());
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map(({ done }) => done));
  }
}
