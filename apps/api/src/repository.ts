import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { projectSchema, type Project } from '@yap/contracts';
import { ApiError, StorageError } from './errors.js';

/** One repository instance per file/process. A database is required for multiple API processes. */
export class ProjectRepository {
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private projects: Project[],
  ) {}

  static async open(file: string): Promise<ProjectRepository> {
    try {
      const contents = await readFile(file, 'utf8');
      const projects = z.array(projectSchema).parse(JSON.parse(contents));
      const ids = new Set(projects.map((project) => project.id));
      if (ids.size !== projects.length) throw new Error('Duplicate project IDs.');
      return new ProjectRepository(file, projects);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return new ProjectRepository(file, []);
      }
      throw new StorageError(
        'Project storage could not be read. Restore a valid data file before starting the API.',
        { cause: error },
      );
    }
  }

  async list(): Promise<Project[]> {
    await this.pending;
    return structuredClone(this.projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Project> {
    await this.pending;
    return structuredClone(this.find(this.projects, id));
  }

  async create(project: Project): Promise<Project> {
    return this.mutate((projects) => {
      projects.push(project);
      return project;
    });
  }

  async update(id: string, update: (project: Project) => Project): Promise<Project> {
    return this.mutate((projects) => {
      const previous = this.find(projects, id);
      const project = projectSchema.parse(update(structuredClone(previous)));
      projects[projects.findIndex((item) => item.id === id)] = project;
      return project;
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate((projects) => {
      this.find(projects, id);
      projects.splice(
        projects.findIndex((project) => project.id === id),
        1,
      );
    });
  }

  private find(projects: Project[], id: string): Project {
    const project = projects.find((item) => item.id === id);
    if (!project) throw new ApiError(404, 'PROJECT_NOT_FOUND', 'This project could not be found.');
    return project;
  }

  private mutate<T>(change: (projects: Project[]) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.projects);
      const result = change(next);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new StorageError(
          'Project changes could not be saved. Check that storage is available.',
          { cause: error },
        );
      }
      this.projects = next;
      return structuredClone(result);
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
