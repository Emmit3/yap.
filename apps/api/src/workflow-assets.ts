import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { z } from 'zod';
import { workflowImageAssetSchema, type WorkflowImageAsset } from '@yap/contracts/workflow';
import { ApiError, StorageError } from './errors.js';

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const formats: Record<string, WorkflowImageAsset['mimeType'] | undefined> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Files are addressed only by server-issued IDs, never by client filenames or remote URLs. */
export class WorkflowAssetStore {
  constructor(private readonly directory: string) {}

  async upload(
    workflowId: string,
    bytes: Buffer,
    mimeType: string,
    filename: string,
  ): Promise<WorkflowImageAsset> {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
      throw new ApiError(400, 'EMPTY_IMAGE', 'Choose a PNG, JPEG, or WebP photo to upload.');
    if (bytes.length > 10 * 1024 * 1024)
      throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Each photo must be at most 10 MB.');
    let metadata: Metadata;
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
      metadata = await image.metadata();
      await image.resize({ width: 1, height: 1, fit: 'inside' }).raw().toBuffer();
    } catch {
      throw new ApiError(
        400,
        'INVALID_IMAGE',
        'This photo could not be decoded. Upload a valid image under 40 megapixels.',
      );
    }
    const actualType = formats[metadata.format ?? ''];
    if (!actualType || actualType !== mimeType)
      throw new ApiError(
        415,
        'IMAGE_TYPE_MISMATCH',
        'Use a PNG, JPEG, or WebP file with its matching Content-Type.',
      );
    if ((metadata.pages ?? 1) > 1)
      throw new ApiError(
        400,
        'ANIMATED_IMAGE_UNSUPPORTED',
        'Use a still photo rather than an animated image.',
      );
    const parsed = workflowImageAssetSchema.safeParse({
      id: randomUUID(),
      filename,
      mimeType: actualType,
      bytes: bytes.length,
      width: metadata.width,
      height: metadata.height,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      description: '',
      createdAt: new Date().toISOString(),
    });
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_IMAGE_METADATA',
        'Use a filename without paths or control characters and image dimensions below 20,001 pixels.',
      );
    const path = this.path(workflowId, parsed.data);
    try {
      await mkdir(resolve(this.directory, workflowId), { recursive: true });
      await writeFile(path, bytes, { flag: 'wx' });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
        await rm(path, { force: true }).catch(() => undefined);
      throw new StorageError(
        'The photo could not be saved. Check available disk space and try again.',
        { cause: error },
      );
    }
    return parsed.data;
  }

  async load(workflowId: string, asset: WorkflowImageAsset): Promise<Buffer> {
    let data: Buffer;
    try {
      data = await readFile(this.path(workflowId, asset));
    } catch (error) {
      throw new StorageError(
        'A saved photo could not be read. Upload the photo again before preparing the promo.',
        { cause: error },
      );
    }
    if (
      data.length !== asset.bytes ||
      createHash('sha256').update(data).digest('hex') !== asset.sha256
    )
      throw new StorageError(
        'A saved photo has changed or is corrupted. Upload the photo again before continuing.',
      );
    return data;
  }

  async remove(workflowId: string, asset: WorkflowImageAsset): Promise<void> {
    await rm(this.path(workflowId, asset), { force: true });
  }

  private path(workflowId: string, asset: WorkflowImageAsset): string {
    z.uuid().parse(workflowId);
    z.uuid().parse(asset.id);
    const extension = extensions[asset.mimeType];
    if (!extension) throw new Error('Unknown stored image type.');
    return resolve(this.directory, workflowId, `${asset.id}.${extension}`);
  }
}
