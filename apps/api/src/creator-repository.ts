import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  creatorSessionSchema,
  creatorJobSchema,
  type CreatorSession,
  type CreatorJob,
} from '@yap/contracts/creator';
import { ApiError, StorageError } from './errors.js';

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessions: z.array(creatorSessionSchema).max(1000),
    jobs: z.array(creatorJobSchema).max(5000),
  })
  .strict();
type State = z.infer<typeof stateSchema>;

/** One owner and one atomic write queue for session revisions and paid-attempt receipts. */
export class CreatorRepository {
  private pending: Promise<void> = Promise.resolve();
  private operations = new Map<string, Promise<void>>();
  private constructor(
    private readonly file: string,
    private state: State,
  ) {}
  static async open(file: string): Promise<CreatorRepository> {
    let state: State;
    try {
      state = stateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return new CreatorRepository(file, { schemaVersion: 1, sessions: [], jobs: [] });
      throw new StorageError(
        'Creator storage could not be read. Restore a valid creator data file.',
        { cause: error },
      );
    }
    const repository = new CreatorRepository(file, state);
    if (state.jobs.some((job) => job.status === 'queued' || job.status === 'running'))
      await repository.mutate((next) => {
        for (const job of next.jobs)
          if (job.status === 'queued' || job.status === 'running') {
            job.status = 'failed';
            job.updatedAt = new Date().toISOString();
            job.error = {
              code: 'CREATOR_INTERRUPTED',
              message:
                'The server restarted. Provider tasks may still be billed; no generation was automatically repeated.',
            };
          }
      });
    return repository;
  }
  checkVersion(session: CreatorSession, expected: number): void {
    if (session.version !== expected)
      throw new ApiError(
        409,
        'CREATOR_VERSION_CONFLICT',
        'This creation changed. Reload and compare your edits before trying again.',
      );
  }
  private find(state: State, id: string): CreatorSession {
    const session = state.sessions.find((item) => item.id === id);
    if (!session) throw new ApiError(404, 'CREATOR_NOT_FOUND', 'This creation was not found.');
    return session;
  }
  /** Spans creator/workflow writes while keeping slow research outside the lock. */
  async withSession<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operations.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(id) === current) this.operations.delete(id);
    }
  }
  async list(): Promise<CreatorSession[]> {
    await this.pending;
    return structuredClone(this.state.sessions).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  async get(id: string): Promise<CreatorSession> {
    await this.pending;
    return structuredClone(this.find(this.state, id));
  }
  async create(session: CreatorSession): Promise<CreatorSession> {
    return this.mutate((state) => {
      if (state.sessions.length >= 1000)
        throw new ApiError(409, 'CREATOR_LIMIT', 'The creator library is full.');
      state.sessions.push(creatorSessionSchema.parse(session));
      return session;
    });
  }
  async update(
    id: string,
    expected: number,
    change: (session: CreatorSession) => CreatorSession,
  ): Promise<CreatorSession> {
    return this.mutate((state) => {
      const current = this.find(state, id);
      this.checkVersion(current, expected);
      const next = creatorSessionSchema.parse({
        ...change(structuredClone(current)),
        id,
        version: current.version + 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      });
      state.sessions[state.sessions.findIndex((item) => item.id === id)] = next;
      return next;
    });
  }
  async jobs(id: string): Promise<CreatorJob[]> {
    await this.pending;
    this.find(this.state, id);
    return structuredClone(this.state.jobs.filter((item) => item.sessionId === id));
  }
  async job(sessionId: string, id: string): Promise<CreatorJob> {
    const job = (await this.jobs(sessionId)).find((item) => item.id === id);
    if (!job) throw new ApiError(404, 'CREATOR_JOB_NOT_FOUND', 'This creation job was not found.');
    return job;
  }
  async addJob(job: CreatorJob, expectedVersion: number): Promise<CreatorJob> {
    return this.mutate((state) => {
      const existing = state.jobs.find(
        (item) => item.sessionId === job.sessionId && item.requestId === job.requestId,
      );
      if (existing) {
        if (existing.kind !== job.kind || existing.approvalId !== job.approvalId)
          throw new ApiError(
            409,
            'CREATOR_REQUEST_CONFLICT',
            'This request ID belongs to a different operation.',
          );
        return existing;
      }
      this.checkVersion(this.find(state, job.sessionId), expectedVersion);
      if (
        state.jobs.some(
          (item) =>
            item.sessionId === job.sessionId &&
            item.kind === job.kind &&
            (item.status === 'queued' || item.status === 'running'),
        )
      )
        throw new ApiError(409, 'CREATOR_JOB_ACTIVE', 'This creation already has an active job.');
      if (state.jobs.length >= 5000)
        throw new ApiError(409, 'CREATOR_JOB_LIMIT', 'Creator job storage is full.');
      state.jobs.push(creatorJobSchema.parse(job));
      return job;
    });
  }
  async updateJob(
    sessionId: string,
    id: string,
    change: (job: CreatorJob) => CreatorJob,
  ): Promise<CreatorJob> {
    return this.mutate((state) => {
      const index = state.jobs.findIndex((item) => item.id === id && item.sessionId === sessionId);
      if (index < 0)
        throw new ApiError(404, 'CREATOR_JOB_NOT_FOUND', 'This creation job was not found.');
      const next = creatorJobSchema.parse({
        ...change(structuredClone(state.jobs[index]!)),
        updatedAt: new Date().toISOString(),
      });
      state.jobs[index] = next;
      return next;
    });
  }
  private async mutate<T>(operation: (state: State) => T): Promise<T> {
    const run = this.pending.then(async () => {
      const next = structuredClone(this.state),
        result = operation(next);
      stateSchema.parse(next);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
        await rename(temporary, this.file);
        this.state = next;
      } catch (error) {
        throw new StorageError('Creator changes could not be saved.', { cause: error });
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      return structuredClone(result);
    });
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
