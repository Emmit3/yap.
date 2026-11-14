import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  socialInvestigationSchema,
  type SocialInvestigation,
  type SocialInvestigationSummary,
} from '@yap/contracts/social';
import { ApiError, StorageError } from './errors.js';

const storeSchema = z.array(socialInvestigationSchema).max(1000);

/** Local single-process persistence; each mutation is validated and atomically replaced. */
export class SocialRepository {
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private investigations: SocialInvestigation[],
  ) {}

  static async open(file: string): Promise<SocialRepository> {
    try {
      const data = storeSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (new Set(data.map((item) => item.id)).size !== data.length)
        throw new Error('Duplicate investigation IDs.');
      return new SocialRepository(file, data);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return new SocialRepository(file, []);
      throw new StorageError(
        'Research storage could not be read. Restore a valid research file before starting the API.',
        { cause: error },
      );
    }
  }

  async list(): Promise<SocialInvestigation[]> {
    await this.pending;
    return structuredClone(this.investigations).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async listSummaries(): Promise<SocialInvestigationSummary[]> {
    await this.pending;
    const summaries = this.investigations.map(
      ({ analysis: _analysis, notes: _notes, ...summary }) => summary,
    );
    return structuredClone(summaries).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<SocialInvestigation> {
    await this.pending;
    return structuredClone(this.find(this.investigations, id));
  }

  async create(investigation: SocialInvestigation): Promise<SocialInvestigation> {
    return this.mutate((items) => {
      if (items.length >= 1000)
        throw new ApiError(
          409,
          'SOCIAL_STORAGE_LIMIT',
          'Delete an older investigation before adding another.',
        );
      if (items.some((item) => item.id === investigation.id))
        throw new ApiError(409, 'SOCIAL_ID_CONFLICT', 'This investigation already exists.');
      items.push(socialInvestigationSchema.parse(investigation));
      return investigation;
    });
  }

  async update(
    id: string,
    change: (previous: SocialInvestigation) => SocialInvestigation,
  ): Promise<SocialInvestigation> {
    return this.mutate((items) => {
      const previous = this.find(items, id);
      const next = socialInvestigationSchema.parse(change(structuredClone(previous)));
      if (next.id !== id) throw new Error('An investigation ID cannot change.');
      items[items.findIndex((item) => item.id === id)] = next;
      return next;
    });
  }

  async delete(id: string): Promise<void> {
    await this.mutate((items) => {
      this.find(items, id);
      items.splice(
        items.findIndex((item) => item.id === id),
        1,
      );
    });
  }

  private find(items: SocialInvestigation[], id: string): SocialInvestigation {
    const item = items.find((investigation) => investigation.id === id);
    if (!item)
      throw new ApiError(404, 'SOCIAL_NOT_FOUND', 'This investigation could not be found.');
    return item;
  }

  private mutate<T>(change: (items: SocialInvestigation[]) => T): Promise<T> {
    const operation = this.pending.then(async () => {
      const next = structuredClone(this.investigations);
      const result = change(next);
      storeSchema.parse(next);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw new StorageError(
          'Research changes could not be saved. Check that storage is available.',
          { cause: error },
        );
      }
      this.investigations = next;
      return structuredClone(result);
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
