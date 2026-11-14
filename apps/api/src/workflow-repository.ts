import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { workflowSchema, type Workflow } from '@yap/contracts/workflow';
import { renderJobSchema, type RenderJob } from '@yap/contracts/render';
import { ApiError, StorageError } from './errors.js';

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    workflows: z.array(workflowSchema).max(1000),
    history: z.record(z.string(), z.array(workflowSchema).max(50)),
    renders: z.array(renderJobSchema).max(5000),
  })
  .strict();
type State = z.infer<typeof stateSchema>;

/** One process owns the store. Slow provider/render work happens outside this atomic commit seam. */
export class WorkflowRepository {
  private pending: Promise<void> = Promise.resolve();
  private constructor(
    private readonly file: string,
    private state: State,
  ) {}

  static async open(file: string): Promise<WorkflowRepository> {
    let state: State;
    try {
      state = stateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (new Set(state.workflows.map((item) => item.id)).size !== state.workflows.length)
        throw new Error('Duplicate workflow IDs.');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return new WorkflowRepository(file, {
          schemaVersion: 1,
          workflows: [],
          history: {},
          renders: [],
        });
      throw new StorageError(
        'Promo storage could not be read. Restore a valid workflow data file before starting the API.',
        { cause: error },
      );
    }
    const repository = new WorkflowRepository(file, state);
    if (state.renders.some((job) => job.status === 'queued' || job.status === 'running')) {
      await repository.mutate((next) => {
        for (const job of next.renders) {
          if (job.status !== 'queued' && job.status !== 'running') continue;
          job.status = 'failed';
          job.completedAt = new Date().toISOString();
          job.output = null;
          job.error = {
            code: 'RENDER_INTERRUPTED',
            message: 'The server stopped during this render. Start a new render to try again.',
          };
        }
      });
    }
    return repository;
  }

  async list(): Promise<Workflow[]> {
    await this.pending;
    return structuredClone(this.state.workflows).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  async get(id: string): Promise<Workflow> {
    await this.pending;
    return structuredClone(this.find(this.state, id));
  }
  async history(id: string): Promise<Workflow[]> {
    await this.pending;
    this.find(this.state, id);
    return structuredClone(this.state.history[id] ?? []).reverse();
  }
  async create(workflow: Workflow): Promise<Workflow> {
    return this.mutate((state) => {
      if (state.workflows.length >= 1000)
        throw new ApiError(
          409,
          'WORKFLOW_LIMIT',
          'This workspace has reached its 1,000 promo limit. Remove an older promo before creating another.',
        );
      state.workflows.push(workflowSchema.parse(workflow));
      state.history[workflow.id] = [structuredClone(workflow)];
      return workflow;
    });
  }
  async update(
    id: string,
    expectedVersion: number,
    change: (workflow: Workflow) => Workflow,
    options: { requireIdle?: boolean } = {},
  ): Promise<Workflow> {
    return this.mutate((state) => {
      const previous = this.find(state, id);
      this.checkVersion(previous, expectedVersion);
      if (
        options.requireIdle &&
        state.renders.some(
          (job) => job.workflowId === id && (job.status === 'queued' || job.status === 'running'),
        )
      )
        throw new ApiError(
          409,
          'RENDER_IN_PROGRESS',
          'Wait for the promo render to finish before deleting its photos.',
        );
      const next = workflowSchema.parse({
        ...change(structuredClone(previous)),
        id: previous.id,
        version: previous.version + 1,
        createdAt: previous.createdAt,
        updatedAt: new Date().toISOString(),
      });
      state.workflows[state.workflows.findIndex((item) => item.id === id)] = next;
      state.history[id] = [...(state.history[id] ?? []), structuredClone(next)].slice(-50);
      return next;
    });
  }
  async delete(id: string, expectedVersion: number): Promise<void> {
    await this.mutate((state) => {
      const workflow = this.find(state, id);
      this.checkVersion(workflow, expectedVersion);
      if (
        state.renders.some(
          (job) => job.workflowId === id && (job.status === 'queued' || job.status === 'running'),
        )
      )
        throw new ApiError(
          409,
          'RENDER_IN_PROGRESS',
          'Wait for this promo render to finish before deleting its photos and workflow.',
        );
      state.workflows = state.workflows.filter((item) => item.id !== id);
      delete state.history[id];
      state.renders = state.renders.filter((job) => job.workflowId !== id);
    });
  }
  async renders(workflowId: string): Promise<RenderJob[]> {
    await this.pending;
    this.find(this.state, workflowId);
    return structuredClone(this.state.renders.filter((job) => job.workflowId === workflowId));
  }
  async interruptedRenders(): Promise<RenderJob[]> {
    await this.pending;
    return structuredClone(
      this.state.renders.filter(
        (job) => job.status === 'failed' && job.error?.code === 'RENDER_INTERRUPTED',
      ),
    );
  }
  async render(workflowId: string, id: string): Promise<RenderJob> {
    await this.pending;
    this.find(this.state, workflowId);
    const job = this.state.renders.find((item) => item.id === id && item.workflowId === workflowId);
    if (!job) throw new ApiError(404, 'RENDER_NOT_FOUND', 'This video render could not be found.');
    return structuredClone(job);
  }
  async createRender(job: RenderJob, expectedVersion: number): Promise<RenderJob> {
    return this.mutate((state) => {
      const workflow = this.find(state, job.workflowId);
      this.checkVersion(workflow, expectedVersion);
      if (
        state.renders.filter((item) => item.status === 'queued' || item.status === 'running')
          .length >= 10
      )
        throw new ApiError(
          429,
          'RENDER_QUEUE_FULL',
          'The render queue is full. Try again after another promo finishes.',
        );
      if (
        state.renders.some(
          (item) =>
            item.workflowId === job.workflowId &&
            item.sourceScenesId === job.sourceScenesId &&
            (item.status === 'queued' || item.status === 'running'),
        )
      )
        throw new ApiError(
          409,
          'RENDER_ALREADY_QUEUED',
          'These scenes already have a render in progress.',
        );
      if (state.renders.length >= 5000)
        throw new ApiError(
          409,
          'RENDER_LIMIT',
          'This workspace has reached its video history limit. Remove an older workflow to free space.',
        );
      if (state.renders.filter((item) => item.workflowId === job.workflowId).length >= 1000)
        throw new ApiError(
          409,
          'RENDER_LIMIT',
          'This promo has reached its 1,000 video history limit. Create a new promo to continue.',
        );
      state.renders.push(renderJobSchema.parse(job));
      return job;
    });
  }
  async updateRender(
    workflowId: string,
    id: string,
    change: (job: RenderJob) => RenderJob,
  ): Promise<RenderJob> {
    return this.mutate((state) => {
      const index = state.renders.findIndex(
        (item) => item.id === id && item.workflowId === workflowId,
      );
      const previous = state.renders[index];
      if (!previous)
        throw new ApiError(404, 'RENDER_NOT_FOUND', 'This video render could not be found.');
      const next = renderJobSchema.parse(change(structuredClone(previous)));
      state.renders[index] = next;
      return next;
    });
  }
  checkVersion(workflow: Workflow, expectedVersion: number): void {
    if (workflow.version !== expectedVersion)
      throw new ApiError(
        409,
        'WORKFLOW_VERSION_CONFLICT',
        `This promo changed while you were editing. Reload version ${workflow.version} before trying again.`,
      );
  }
  private find(state: State, id: string): Workflow {
    const workflow = state.workflows.find((item) => item.id === id);
    if (!workflow)
      throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'This promo workflow could not be found.');
    return workflow;
  }
  private mutate<T>(change: (state: State) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.state),
        result = change(next);
      stateSchema.parse(next);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx', encoding: 'utf8' });
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new StorageError(
          'Promo changes could not be saved. Check available disk space and try again.',
          { cause: error },
        );
      }
      this.state = next;
      return structuredClone(result);
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
