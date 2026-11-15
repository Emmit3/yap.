import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  posterDesignSchema,
  posterReferenceSchema,
  posterProductionPlanSchema,
  type PosterDesign,
} from '@yap/contracts/posters';
import { ApiError, StorageError } from './errors.js';
import type { PreparedPosterStyle } from './poster-references.js';
import { posterPlanMatchesReference } from './poster-production.js';

const MAX_DESIGNS = 250;
const MAX_STORAGE_BYTES = 16 * 1024 * 1024;
const privatePrompt = z
  .string()
  .min(1)
  .max(64 * 1024)
  .refine((value) => Buffer.byteLength(value) <= 64 * 1024);
const storedDesignSchema = posterDesignSchema
  .extend({
    originalStylePrompt: privatePrompt,
    combinedPrompt: privatePrompt,
    reference: posterReferenceSchema,
    // Optional on old records; never reconstruct a historical plan from a newer catalog.
    productionPlan: posterProductionPlanSchema.optional(),
  })
  .strict()
  .refine(
    (record) =>
      record.reference.id === record.style.id &&
      record.reference.crop.sha256 === record.style.crop.sha256 &&
      record.combinedPrompt.startsWith(record.originalStylePrompt) &&
      (!record.productionPlan ||
        (record.productionPlan.changes === record.changes &&
          posterPlanMatchesReference(record.productionPlan, record.reference))),
    'The private design must retain its selected style and original prompt.',
  );
const storageSchema = z
  .object({
    schemaVersion: z.literal(1),
    designs: z.array(storedDesignSchema).max(MAX_DESIGNS),
  })
  .strict()
  .refine(
    (storage) =>
      new Set(storage.designs.map((design) => design.id)).size === storage.designs.length,
  );
type StoredDesign = z.infer<typeof storedDesignSchema>;

function customerDesign(record: StoredDesign): PosterDesign {
  return {
    id: record.id,
    style: record.style,
    changes: record.changes,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.productionPlan ? { brief: structuredClone(record.productionPlan.brief) } : {}),
  };
}

/** One instance per file/process, matching the local application's storage model. */
export class PosterDesignRepository {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async read(): Promise<StoredDesign[]> {
    try {
      const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_STORAGE_BYTES)
          throw new Error('Invalid design storage size.');
        bytes = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, null);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length !== info.size || length > MAX_STORAGE_BYTES)
          throw new Error('Design storage changed during reading.');
        bytes = bytes.subarray(0, length);
      } finally {
        await handle.close();
      }
      return storageSchema.parse(JSON.parse(bytes.toString('utf8'))).designs;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new StorageError(
        'Saved poster designs could not be read. Restore valid local design storage before continuing.',
        { cause: error },
      );
    }
  }

  private async persist(designs: StoredDesign[]): Promise<void> {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, designs }));
    if (bytes.length > MAX_STORAGE_BYTES)
      throw new ApiError(
        409,
        'POSTER_DESIGN_LIMIT',
        'Saved poster designs have reached this workspace’s storage limit.',
      );
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new StorageError(
        'The poster design could not be saved. Check local storage and try again.',
        { cause: error },
      );
    }
  }

  async get(id: string): Promise<PosterDesign> {
    await this.pending;
    const record = (await this.read()).find((design) => design.id === id);
    if (!record)
      throw new ApiError(
        404,
        'POSTER_DESIGN_NOT_FOUND',
        'This saved poster design could not be found.',
      );
    return structuredClone(customerDesign(record));
  }

  create(prepared: PreparedPosterStyle): Promise<PosterDesign> {
    const operation = this.pending.then(async () => {
      const designs = await this.read();
      if (designs.length >= MAX_DESIGNS)
        throw new ApiError(
          409,
          'POSTER_DESIGN_LIMIT',
          'This workspace has reached its saved poster design limit.',
        );
      const record = storedDesignSchema.parse({
        id: randomUUID(),
        style: prepared.style,
        changes: prepared.changes,
        status: 'prepared',
        createdAt: new Date().toISOString(),
        originalStylePrompt: prepared.originalStylePrompt,
        combinedPrompt: prepared.combinedPrompt,
        reference: prepared.reference,
        productionPlan: prepared.productionPlan,
      });
      await this.persist([...designs, record]);
      return structuredClone(customerDesign(record));
    });
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
