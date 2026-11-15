import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import {
  referenceAnalysisSchema,
  referenceAnalyzeSchema,
  referenceCueSchema,
  referenceImportSchema,
  type ReferenceAnalysis,
  type ReferenceAnalyze,
  type ReferenceFrame,
  type ReferenceImport,
} from '@yap/contracts/reference-assets';
import { ApiError } from './errors.js';
import { productionStore, verifyProductionFile } from './creator-production-storage.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function timestamp(value: string): number {
  const match = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60)
    throw new ApiError(
      400,
      'REFERENCE_TRANSCRIPT_TIMING',
      'Use mm:ss.mmm or hh:mm:ss.mmm cue timestamps.',
    );
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]!.padEnd(3, '0')) / 1000
  );
}
/** Parses provided cue timing. It never transcribes media or invents timestamps. */
export function parseReferenceTranscript(format: ReferenceImport['format'], input: string) {
  if (
    Buffer.byteLength(input, 'utf8') > 64000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input)
  )
    throw new ApiError(
      400,
      'REFERENCE_TRANSCRIPT_LIMIT',
      'Keep the transcript within 64 KB of plain caption text.',
    );
  const normalized = input
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const blocks = normalized.split(/\n\s*\n/u);
  const cues: z.infer<typeof referenceCueSchema>[] = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (format === 'vtt' && /^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0]!)) continue;
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0)
      throw new ApiError(
        400,
        'REFERENCE_TRANSCRIPT_TIMING',
        'Every cue needs an explicit start --> end timestamp and its text.',
      );
    const match = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/u.exec(lines[at]!);
    if (!match)
      throw new ApiError(400, 'REFERENCE_TRANSCRIPT_TIMING', 'The cue timestamp line is invalid.');
    const text = lines
      .slice(at + 1)
      .join(' ')
      .replace(/<\/?(?:v|c|b|i|u|ruby|rt)(?:[ .][^>]*)?>/gu, '')
      .trim();
    const cue = referenceCueSchema.parse({
      start: timestamp(match[1]!),
      end: timestamp(match[2]!),
      text,
    });
    if (cue.start < (cues.at(-1)?.start ?? 0))
      throw new ApiError(
        400,
        'REFERENCE_TRANSCRIPT_TIMING',
        'Keep transcript cues in chronological order.',
      );
    cues.push(cue);
    if (cues.length > 1000)
      throw new ApiError(400, 'REFERENCE_TRANSCRIPT_LIMIT', 'Use at most 1000 transcript cues.');
  }
  if (!cues.length)
    throw new ApiError(400, 'REFERENCE_TRANSCRIPT_EMPTY', 'Add at least one timed transcript cue.');
  return cues;
}
export interface ReferenceSceneInput {
  sessionId: string;
  referenceId: string;
  sourceHash: string;
  cues: ReferenceAnalysis['cues'];
  frames: Array<{
    id: string;
    atSeconds: number;
    mimeType: 'image/jpeg';
    sha256: string;
    bytes: Buffer;
  }>;
}
export interface ReferenceSceneResult {
  model: string;
  summary: string;
  observations: Array<{ frameId: string; text: string }>;
  limitations: string[];
}
export type ReferenceSceneAnalyzer = (
  input: ReferenceSceneInput,
  approval: ReferenceAnalyze,
  signal: AbortSignal,
) => Promise<ReferenceSceneResult>;
const resultSchema = z
  .object({
    model: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(6000),
    observations: z
      .array(z.object({ frameId: z.uuid(), text: z.string().trim().min(1).max(2000) }).strict())
      .max(32),
    limitations: z.array(z.string().trim().min(1).max(1000)).max(18),
  })
  .strict();
const stateSchema = z.object({ references: z.array(referenceAnalysisSchema).max(100) }).strict();
type ReferenceState = z.infer<typeof stateSchema>;
function sourceHash(record: Pick<ReferenceAnalysis, 'transcriptHash' | 'frames' | 'observations'>) {
  return hash(
    JSON.stringify({
      transcriptHash: record.transcriptHash,
      frames: record.frames.map(({ id, atSeconds, sha256 }) => ({ id, atSeconds, sha256 })),
      notes: record.observations.filter((note) => note.origin === 'creator'),
    }),
  );
}
export function createReferenceAnalysisService(
  directory: string,
  options: { analyzeFrames?: ReferenceSceneAnalyzer } = {},
) {
  const stores = new Map<string, ReturnType<typeof productionStore<ReferenceState>>>();
  function storeFor(sessionId: string) {
    z.uuid().parse(sessionId);
    let pending = stores.get(sessionId);
    if (!pending) {
      pending = productionStore(
        join(directory, sessionId, 'reference-analysis.json'),
        stateSchema,
        { references: [] },
      ).then(async (store) => {
        const prior = await store.read();
        if (
          prior.references.some((record) =>
            record.requests.some((request) => request.status === 'running'),
          )
        )
          await store.mutate((state) => {
            for (const record of state.references)
              for (const request of record.requests)
                if (request.status === 'running') {
                  request.status = 'failed';
                  request.error =
                    'Analysis was interrupted; the provider outcome may be unknown. A new request requires fresh cost approval.';
                }
          });
        return store;
      });
      stores.set(sessionId, pending);
    }
    return pending;
  }
  const framePath = (sessionId: string, referenceId: string, frameId: string) => {
    z.uuid().parse(sessionId);
    z.uuid().parse(referenceId);
    z.uuid().parse(frameId);
    return join(directory, sessionId, 'reference-frames', referenceId, `${frameId}.jpg`);
  };
  async function get(sessionId: string, referenceId: string) {
    z.uuid().parse(referenceId);
    const record = (await (await storeFor(sessionId)).read()).references.find(
      (item) => item.id === referenceId,
    );
    if (!record)
      throw new ApiError(
        404,
        'REFERENCE_ANALYSIS_NOT_FOUND',
        'This reference is not in this creation.',
      );
    return record;
  }
  async function verifyFrame(sessionId: string, referenceId: string, frameId: string) {
    z.uuid().parse(frameId);
    const record = await get(sessionId, referenceId),
      frame = record.frames.find((item) => item.id === frameId);
    if (!frame)
      throw new ApiError(
        404,
        'REFERENCE_FRAME_NOT_FOUND',
        'This sampled frame is not in this reference.',
      );
    const path = framePath(sessionId, referenceId, frameId);
    await verifyProductionFile(path, frame);
    const bytes = await readFile(path);
    if (bytes.length !== frame.bytes || hash(bytes) !== frame.sha256)
      throw new ApiError(
        409,
        'CREATOR_PRODUCTION_INTEGRITY',
        'The sampled reference frame changed while it was read.',
      );
    return { frame, bytes };
  }
  function current(record: ReferenceAnalysis | undefined, expectedVersion: number) {
    if (!record)
      throw new ApiError(
        404,
        'REFERENCE_ANALYSIS_NOT_FOUND',
        'This reference is not in this creation.',
      );
    if (record.version !== expectedVersion)
      throw new ApiError(
        409,
        'REFERENCE_ANALYSIS_VERSION',
        'The reference changed. Reload it before saving.',
      );
    return record;
  }
  function invalidate(record: ReferenceAnalysis) {
    delete record.analysis;
    record.observations = record.observations.filter((item) => item.origin === 'creator');
    record.sourceHash = sourceHash(record);
    record.version++;
    record.updatedAt = new Date().toISOString();
  }
  return {
    configured: Boolean(options.analyzeFrames),
    get,
    verifyFrame,
    async list(sessionId: string) {
      return (await (await storeFor(sessionId)).read()).references;
    },
    async import(sessionId: string, value: ReferenceImport) {
      const input = referenceImportSchema.parse(value),
        cues = parseReferenceTranscript(input.format, input.transcript),
        now = new Date().toISOString();
      const record = referenceAnalysisSchema.parse({
        id: randomUUID(),
        sessionId,
        version: 1,
        title: input.title,
        sourceUrl: input.sourceUrl,
        transcriptFormat: input.format,
        transcriptHash: hash(input.transcript),
        sourceHash: '0'.repeat(64),
        cues,
        frames: [],
        observations: [],
        requests: [],
        provenance: 'attributed_external_reference',
        importedAt: now,
        updatedAt: now,
      });
      record.sourceHash = sourceHash(record);
      await (
        await storeFor(sessionId)
      ).mutate((state) => {
        if (state.references.length >= 100)
          throw new ApiError(
            409,
            'REFERENCE_ANALYSIS_LIMIT',
            'This creation has reached its reference import limit.',
          );
        state.references.push(record);
      });
      return record;
    },
    async addFrame(
      sessionId: string,
      referenceId: string,
      input: { expectedVersion: number; atSeconds: number; bytes: Buffer },
    ) {
      z.number().min(0).max(7200).parse(input.atSeconds);
      z.number().int().positive().parse(input.expectedVersion);
      if (input.bytes.length < 100 || input.bytes.length > 5 * 1024 * 1024)
        throw new ApiError(
          400,
          'REFERENCE_FRAME_SIZE',
          'Upload a JPEG, PNG or WebP frame under 5 MB.',
        );
      const image = sharp(input.bytes, { limitInputPixels: 16_000_000, failOn: 'warning' }),
        metadata = await image.metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
        throw new ApiError(400, 'REFERENCE_FRAME_FORMAT', 'Use one still JPEG, PNG or WebP frame.');
      const normalized = await image
        .rotate()
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer({ resolveWithObject: true });
      if (normalized.data.length > 512 * 1024)
        throw new ApiError(
          400,
          'REFERENCE_FRAME_SIZE',
          'The decoded frame is too complex. Upload a smaller sample.',
        );
      const frame: ReferenceFrame = {
        id: randomUUID(),
        atSeconds: input.atSeconds,
        mimeType: 'image/jpeg',
        bytes: normalized.data.length,
        sha256: hash(normalized.data),
        width: normalized.info.width,
        height: normalized.info.height,
      };
      return (await storeFor(sessionId)).mutate(async (state) => {
        const record = current(
          state.references.find((item) => item.id === referenceId),
          input.expectedVersion,
        );
        if (record.frames.length >= 8)
          throw new ApiError(
            409,
            'REFERENCE_FRAME_LIMIT',
            'Analyze at most eight sampled frames per reference.',
          );
        const path = framePath(sessionId, referenceId, frame.id);
        await mkdir(join(directory, sessionId, 'reference-frames', referenceId), {
          recursive: true,
        });
        await writeFile(path, normalized.data, { flag: 'wx' });
        record.frames.push(frame);
        invalidate(record);
        return record;
      });
    },
    async addObservation(
      sessionId: string,
      referenceId: string,
      input: { expectedVersion: number; text: string; atSeconds?: number },
    ) {
      const observation = z
        .object({
          text: z.string().trim().min(1).max(2000),
          atSeconds: z.number().min(0).max(7200).optional(),
        })
        .strict()
        .parse({ text: input.text, atSeconds: input.atSeconds });
      return (await storeFor(sessionId)).mutate((state) => {
        const record = current(
          state.references.find((item) => item.id === referenceId),
          input.expectedVersion,
        );
        if (record.observations.filter((item) => item.origin === 'creator').length >= 50)
          throw new ApiError(
            409,
            'REFERENCE_NOTE_LIMIT',
            'Keep at most fifty manual reference notes.',
          );
        record.observations.push({ ...observation, origin: 'creator' });
        invalidate(record);
        return record;
      });
    },
    async analyze(
      sessionId: string,
      referenceId: string,
      value: ReferenceAnalyze,
      signal = new AbortController().signal,
    ) {
      const approval = referenceAnalyzeSchema.parse(value);
      if (!options.analyzeFrames)
        throw new ApiError(
          503,
          'REFERENCE_VISION_NOT_CONFIGURED',
          'Configure approved visual analysis, or keep manual reference notes.',
        );
      const store = await storeFor(sessionId);
      const admitted = await store.mutate((state) => {
        const found = state.references.find((item) => item.id === referenceId);
        const prior = found?.requests.find((item) => item.requestId === approval.requestId);
        if (prior) {
          if (prior.sourceHash !== approval.sourceHash)
            throw new ApiError(
              409,
              'REFERENCE_ANALYSIS_REQUEST_CONFLICT',
              'This request ID belongs to a different reference snapshot.',
            );
          return { record: found!, start: false };
        }
        const record = current(found, approval.expectedVersion);
        if (record.sourceHash !== approval.sourceHash)
          throw new ApiError(
            409,
            'REFERENCE_ANALYSIS_SOURCE_CHANGED',
            'The reference changed. Review its new source snapshot and cost.',
          );
        if (!record.frames.length)
          throw new ApiError(
            400,
            'REFERENCE_FRAMES_REQUIRED',
            'Upload at least one timestamped sample frame before AI visual analysis.',
          );
        if (record.requests.filter((item) => item.sourceHash === approval.sourceHash).length >= 2)
          throw new ApiError(
            409,
            'REFERENCE_ANALYSIS_ATTEMPT_LIMIT',
            'This reference snapshot has used both manual analysis attempts.',
          );
        if (record.requests.length >= 100)
          throw new ApiError(
            409,
            'REFERENCE_ANALYSIS_LIMIT',
            'This reference has reached its saved analysis limit.',
          );
        record.requests.push({
          requestId: approval.requestId,
          sourceHash: approval.sourceHash,
          status: 'running',
          createdAt: new Date().toISOString(),
        });
        record.version++;
        record.updatedAt = new Date().toISOString();
        return { record, start: true };
      });
      if (!admitted.start) return admitted.record;
      try {
        const frames = await Promise.all(
          admitted.record.frames.map(async (frame) => {
            const verified = await verifyFrame(sessionId, referenceId, frame.id);
            return { ...verified.frame, bytes: verified.bytes };
          }),
        );
        signal.throwIfAborted();
        const result = resultSchema.parse(
          await options.analyzeFrames(
            {
              sessionId,
              referenceId,
              sourceHash: approval.sourceHash,
              cues: admitted.record.cues,
              frames,
            },
            approval,
            signal,
          ),
        );
        if (result.observations.some((note) => !frames.some((frame) => frame.id === note.frameId)))
          throw new ApiError(
            502,
            'REFERENCE_ANALYSIS_FRAME_MISMATCH',
            'The analysis referred to a frame outside this approved snapshot.',
          );
        const saved = await store.mutate((state) => {
          const record = state.references.find((item) => item.id === referenceId)!,
            request = record.requests.find((item) => item.requestId === approval.requestId)!;
          if (record.sourceHash !== approval.sourceHash) {
            request.status = 'failed';
            request.error = 'The reference changed while analysis was running.';
            return { record, stale: true };
          }
          record.observations = [
            ...record.observations.filter((note) => note.origin === 'creator'),
            ...result.observations.map((note) => ({
              ...note,
              origin: 'ai' as const,
              atSeconds: frames.find((frame) => frame.id === note.frameId)!.atSeconds,
            })),
          ];
          record.analysis = {
            model: result.model,
            summary: result.summary,
            sourceHash: approval.sourceHash,
            analyzedAt: new Date().toISOString(),
            limitations: [
              ...result.limitations,
              'Only uploaded sampled frames were analyzed; unsampled moments are unknown.',
              'Transcript text was supplied by the creator and was not independently transcribed or verified.',
            ],
          };
          request.status = 'succeeded';
          record.version++;
          record.updatedAt = new Date().toISOString();
          return { record, stale: false };
        });
        if (saved.stale)
          throw new ApiError(
            409,
            'REFERENCE_ANALYSIS_SOURCE_CHANGED',
            'The reference changed during analysis; results were not applied.',
          );
        return saved.record;
      } catch (error) {
        await store.mutate((state) => {
          const record = state.references.find((item) => item.id === referenceId)!;
          const request = record.requests.find((item) => item.requestId === approval.requestId)!;
          request.status = 'failed';
          request.error =
            error instanceof ApiError
              ? error.message
              : 'Visual analysis did not complete. Its provider outcome may be unknown; review before manually retrying.';
          record.updatedAt = new Date().toISOString();
        });
        throw error;
      }
    },
  };
}
