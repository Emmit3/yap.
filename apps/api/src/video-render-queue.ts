import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Workflow } from '@yap/contracts/workflow';
import type { RenderJob } from '@yap/contracts/render';
import { ApiError } from './errors.js';
import { verifyWorkflow } from './workflow-engine.js';
import { WorkflowAssetStore } from './workflow-assets.js';
import { WorkflowRepository } from './workflow-repository.js';
import { renderPromoVideo, type RenderOptions, type RenderResult } from './video-renderer.js';

export type PromoRenderer = (options: RenderOptions) => Promise<RenderResult>;

/** Bounded, serial render execution; durable job receipts live in the workflow repository. */
export class VideoRenderQueue {
  private queue: Array<{ job: RenderJob; workflow: Workflow }> = [];
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private stopping = false;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly assets: WorkflowAssetStore,
    private readonly directory: string,
    private readonly renderer: PromoRenderer = renderPromoVideo,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async enqueue(workflow: Workflow, expectedVersion: number): Promise<RenderJob> {
    if (this.stopping)
      throw new ApiError(
        503,
        'RENDER_UNAVAILABLE',
        'The server is shutting down. Try again after it restarts.',
      );
    this.assertApproved(workflow);
    if (
      workflow.assets.length === 0 ||
      workflow.scenes!.scenes.some((scene) => scene.assetIds.length === 0)
    )
      throw new ApiError(
        409,
        'RENDER_PHOTOS_REQUIRED',
        'Upload business or product photos and include a photo in every scene before rendering.',
      );
    const job: RenderJob = {
      id: randomUUID(),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      sourceScenesId: workflow.scenes!.id,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      width: 1080,
      height: 1920,
      duration: workflow.brief.duration!,
      output: null,
      error: null,
    };
    await this.repository.createRender(job, expectedVersion);
    if (this.stopping) {
      await this.fail(
        job,
        'RENDER_INTERRUPTED',
        'The server stopped before this render began. Start another render after restarting.',
      );
      throw new ApiError(
        503,
        'RENDER_UNAVAILABLE',
        'The server is shutting down. Try again after it restarts.',
      );
    }
    this.queue.push({ job, workflow: structuredClone(workflow) });
    this.start();
    return job;
  }

  path(id: string): string {
    z.uuid().parse(id);
    return resolve(this.directory, `${id}.mp4`);
  }

  private workPath(id: string): string {
    z.uuid().parse(id);
    const parent = resolve(this.directory),
      target = resolve(parent, `.${id}.work`);
    const within = relative(parent, target);
    if (!within || within.startsWith('..') || isAbsolute(within))
      throw new Error('Invalid render workspace path.');
    return target;
  }

  async recoverInterrupted(): Promise<void> {
    for (const job of await this.repository.interruptedRenders()) {
      await rm(this.path(job.id), { force: true });
      // workPath checks the resolved absolute target is a direct child of this render store.
      await rm(this.workPath(job.id), { recursive: true, force: true });
    }
  }

  async verifyOutput(job: RenderJob): Promise<string> {
    const path = this.path(job.id);
    let bytes: number;
    try {
      bytes = (await stat(path)).size;
    } catch {
      throw new ApiError(
        404,
        'VIDEO_FILE_MISSING',
        'The video file is missing. Start a new render to download it.',
      );
    }
    if (!job.output || bytes !== job.output.bytes)
      throw new ApiError(
        500,
        'VIDEO_FILE_CORRUPTED',
        'The saved video has changed. Start a new render.',
      );
    const hash = createHash('sha256');
    try {
      for await (const chunk of createReadStream(path)) hash.update(chunk);
    } catch {
      throw new ApiError(
        500,
        'VIDEO_FILE_UNREADABLE',
        'The video file could not be read. Start a new render.',
      );
    }
    if (hash.digest('hex') !== job.output.sha256)
      throw new ApiError(
        500,
        'VIDEO_FILE_CORRUPTED',
        'The saved video has changed. Start a new render.',
      );
    return path;
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    const queued = this.queue.splice(0);
    for (const { job } of queued) {
      await this.fail(
        job,
        'RENDER_INTERRUPTED',
        'The server stopped before this render began. Start another render after restarting.',
      );
    }
    await this.active;
  }

  private assertApproved(workflow: Workflow): void {
    const verification = verifyWorkflow(workflow);
    if (Object.values(verification).some((report) => report.state !== 'approved'))
      throw new ApiError(
        409,
        'PROMO_APPROVAL_REQUIRED',
        'Review and approve the current promo before rendering a video.',
      );
  }

  private start(): void {
    if (this.active || this.stopping) return;
    this.active = this.pump()
      .catch((error) => this.onError(error))
      .finally(() => {
        this.active = undefined;
        if (this.queue.length && !this.stopping) this.start();
      });
  }

  private async pump(): Promise<void> {
    while (this.queue.length && !this.stopping) {
      const item = this.queue.shift()!;
      const { job, workflow } = item;
      const path = this.path(job.id);
      this.controller = new AbortController();
      try {
        await this.assertCurrent(job);
        await this.repository.updateRender(job.workflowId, job.id, (current) => ({
          ...current,
          status: 'running',
          startedAt: new Date().toISOString(),
        }));
        const result = await this.renderer({
          workflow,
          outputPath: path,
          workDirectory: this.workPath(job.id),
          loadAsset: (asset) => this.assets.load(workflow.id, asset),
          signal: this.controller.signal,
        });
        if (this.stopping || this.controller.signal.aborted)
          throw new ApiError(
            409,
            'RENDER_INTERRUPTED',
            'The server stopped during rendering. Start a new render to try again.',
          );
        await this.assertCurrent(job);
        await this.repository.updateRender(job.workflowId, job.id, (current) => ({
          ...current,
          status: 'succeeded',
          completedAt: new Date().toISOString(),
          output: { bytes: result.bytes, sha256: result.sha256 },
          error: null,
        }));
      } catch (error) {
        await rm(path, { force: true }).catch(this.onError);
        this.onError(error);
        await this.fail(
          job,
          error instanceof ApiError ? error.code : 'RENDER_FAILED',
          error instanceof ApiError
            ? error.message
            : 'The video could not be rendered. Try again or upload different photos.',
        );
      } finally {
        this.controller = undefined;
      }
    }
  }

  private async assertCurrent(job: RenderJob): Promise<void> {
    const current = await this.repository.get(job.workflowId);
    if (current.scenes?.id !== job.sourceScenesId)
      throw new ApiError(
        409,
        'RENDER_SOURCE_CHANGED',
        'The promo changed during rendering. Review the new scenes and render again.',
      );
    this.assertApproved(current);
  }

  private async fail(job: RenderJob, code: string, message: string): Promise<void> {
    await this.repository.updateRender(job.workflowId, job.id, (current) => ({
      ...current,
      status: 'failed',
      completedAt: new Date().toISOString(),
      output: null,
      error: { code, message },
    }));
  }
}
