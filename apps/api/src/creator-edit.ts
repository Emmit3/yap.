import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  editBaseFilmSchema,
  editDraftSchema,
  editDocumentSchema,
  editRenderReceiptSchema,
  editUpdateSchema,
  editRenderSchema,
  editDuration,
  type EditBaseFilm,
  type EditDraft,
  type EditDocument,
} from '@yap/contracts/production';
import { ApiError } from './errors.js';
import {
  createBrandService,
  renderBrandMovie,
  wrapProductionText,
  prepareProductionFont,
  productionFontName,
} from './creator-brand.js';
import {
  clampProductionText,
  productionTextAss,
  type ProductionTextLayer,
} from './creator-production-text.js';
import {
  productionStore,
  verifyProductionFile,
  runProductionFfmpeg,
  productionMovieReceipt,
} from './creator-production-storage.js';

const revisionSchema = z
  .object({
    version: z.number().int().positive(),
    draft: editDraftSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    edits: z
      .array(
        z
          .object({ document: editDocumentSchema, history: z.array(revisionSchema).min(1).max(60) })
          .strict(),
      )
      .max(200),
  })
  .strict();
function checkDraft(base: EditBaseFilm, draft: EditDraft): void {
  for (const segment of draft.segments) {
    const source = base.clips.find((clip) => clip.id === segment.sourceClipId);
    if (!source || segment.trimOut > source.end - source.start + 0.001)
      throw new ApiError(
        422,
        'CREATOR_EDIT_RANGE',
        'Each trim must stay within its original approved clip.',
      );
  }
  if (draft.brand?.endCard.enabled && draft.brand.endCard.seconds >= editDuration(draft))
    throw new ApiError(
      422,
      'CREATOR_BRAND_END_CARD',
      'Keep the brand end card shorter than the edited film.',
    );
}
/** Edit revisions and receipts are stored separately; generation jobs and spending are never mutated. */
export async function createEditService(directory: string) {
  const root = resolve(directory),
    renders = join(root, 'edit-renders');
  const store = await productionStore(join(root, 'creator-edits.json'), stateSchema, {
    schemaVersion: 1 as const,
    edits: [],
  });
  const brands = await createBrandService(root);
  let active = false;
  const find = (state: z.infer<typeof stateSchema>, sessionId: string, id: string) => {
    const value = state.edits.find(
      (item) => item.document.id === id && item.document.sessionId === sessionId,
    );
    if (!value) throw new ApiError(404, 'CREATOR_EDIT_NOT_FOUND', 'This saved edit was not found.');
    return value;
  };
  const checkVersion = (document: EditDocument, expected: number) => {
    if (document.version !== expected)
      throw new ApiError(
        409,
        'CREATOR_EDIT_VERSION_CONFLICT',
        'This edit changed. Reload it before saving or rendering.',
      );
  };
  return {
    async list(sessionId: string) {
      z.uuid().parse(sessionId);
      return (await store.read()).edits
        .filter((item) => item.document.sessionId === sessionId)
        .map((item) => item.document)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(sessionId: string, id: string) {
      return find(await store.read(), sessionId, id).document;
    },
    async history(sessionId: string, id: string) {
      return find(await store.read(), sessionId, id).history;
    },
    async create(sessionId: string, input: EditBaseFilm): Promise<EditDocument> {
      z.uuid().parse(sessionId);
      const base = editBaseFilmSchema.parse(input),
        at = new Date().toISOString();
      const document = editDocumentSchema.parse({
        id: randomUUID(),
        sessionId,
        version: 1,
        base,
        draft: {
          segments: base.clips.map((clip) => ({
            id: randomUUID(),
            sourceClipId: clip.id,
            trimIn: 0,
            trimOut: clip.end - clip.start,
            transition: 'cut',
            transitionSeconds: 0.3,
          })),
          textLayers: [],
          brand: null,
        },
        createdAt: at,
        updatedAt: at,
        renders: [],
      });
      return store.mutate((next) => {
        if (next.edits.length >= 200)
          throw new ApiError(409, 'CREATOR_EDIT_LIMIT', 'The workspace edit library is full.');
        next.edits.push({
          document,
          history: [{ version: document.version, draft: document.draft, updatedAt: at }],
        });
        return document;
      });
    },
    async update(
      sessionId: string,
      id: string,
      input: z.input<typeof editUpdateSchema>,
    ): Promise<EditDocument> {
      const value = editUpdateSchema.parse(input);
      // Expose one saved frame grid rather than accumulating encoder rounding per cut.
      const draft = editDraftSchema.parse({
        ...value.draft,
        segments: value.draft.segments.map((segment) => ({
          ...segment,
          trimIn: Math.round(segment.trimIn * 24) / 24,
          trimOut: Math.round(segment.trimOut * 24) / 24,
          transitionSeconds: Math.max(3, Math.round(segment.transitionSeconds * 24)) / 24,
        })),
      });
      if (draft.brand) await brands.verifySnapshot(draft.brand);
      return store.mutate((next) => {
        const record = find(next, sessionId, id),
          current = record.document;
        checkVersion(current, value.expectedVersion);
        checkDraft(current.base, draft);
        if (record.history.length >= 60)
          throw new ApiError(
            409,
            'CREATOR_EDIT_REVISION_LIMIT',
            'This edit has reached 60 saved versions. Start another edit from the original film.',
          );
        record.document = {
          ...current,
          version: current.version + 1,
          draft,
          updatedAt: new Date().toISOString(),
        };
        record.history.push({
          version: record.document.version,
          draft: record.document.draft,
          updatedAt: record.document.updatedAt,
        });
        return record.document;
      });
    },
    async render(
      sessionId: string,
      id: string,
      input: z.input<typeof editRenderSchema>,
      sourcePath: string,
      callerSignal: AbortSignal,
    ) {
      const value = editRenderSchema.parse(input),
        document = find(await store.read(), sessionId, id).document;
      checkVersion(document, value.expectedVersion);
      checkDraft(document.base, document.draft);
      if (document.renders.length >= 40)
        throw new ApiError(
          409,
          'CREATOR_EDIT_RENDER_LIMIT',
          'This edit has reached its local render limit.',
        );
      if (active)
        throw new ApiError(
          409,
          'CREATOR_EDIT_BUSY',
          'Another local edit is rendering. Wait for it to finish.',
        );
      active = true;
      const renderId = randomUUID(),
        work = join(root, 'edit-work', renderId),
        output = join(renders, `${renderId}.mp4`);
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(300_000)]);
      try {
        signal.throwIfAborted();
        await verifyProductionFile(sourcePath, document.base);
        await mkdir(work, { recursive: true });
        await mkdir(renders, { recursive: true });
        const inputs: string[] = [];
        for (const [index, segment] of document.draft.segments.entries()) {
          const source = document.base.clips.find((clip) => clip.id === segment.sourceClipId)!;
          const target = join(work, `clip-${index}.mp4`);
          await runProductionFfmpeg(
            [
              '-protocol_whitelist',
              'file,pipe',
              '-ss',
              String(source.start + segment.trimIn),
              '-i',
              resolve(sourcePath),
              '-t',
              String(segment.trimOut - segment.trimIn),
              '-map',
              '0:v:0',
              '-map',
              '0:a?',
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-crf',
              '21',
              '-threads',
              '2',
              '-vf',
              'fps=24,setsar=1',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-ar',
              '48000',
              '-ac',
              '2',
              '-map_metadata',
              '-1',
              '-y',
              target,
            ],
            signal,
            work,
          );
          inputs.push('-i', target);
        }
        const filters: string[] = [];
        document.draft.segments.forEach((_segment, index) => {
          // FFmpeg 7 clears frame-rate metadata in setpts. Restore the saved
          // 24 fps grid afterwards so xfade receives CFR inputs on every OS.
          filters.push(`[${index}:v]setpts=PTS-STARTPTS,fps=24,settb=AVTB[v${index}]`);
          if (document.base.hasAudio) filters.push(`[${index}:a]asetpts=PTS-STARTPTS[a${index}]`);
        });
        let video = 'v0',
          audio = 'a0',
          duration = document.draft.segments[0]!.trimOut - document.draft.segments[0]!.trimIn;
        for (let index = 1; index < document.draft.segments.length; index++) {
          const previous = document.draft.segments[index - 1]!,
            segment = document.draft.segments[index]!,
            nextVideo = `joinedv${index}`,
            nextAudio = `joineda${index}`;
          if (previous.transition === 'dissolve') {
            filters.push(
              `[${video}][v${index}]xfade=transition=fade:duration=${previous.transitionSeconds}:offset=${duration - previous.transitionSeconds}[${nextVideo}]`,
            );
            if (document.base.hasAudio)
              filters.push(
                `[${audio}][a${index}]acrossfade=d=${previous.transitionSeconds}:c1=tri:c2=tri[${nextAudio}]`,
              );
            duration -= previous.transitionSeconds;
          } else {
            // Concat also clears CFR metadata; a later dissolve must see the
            // same rate and timebase as the incoming source clip.
            filters.push(`[${video}][v${index}]concat=n=2:v=1:a=0,fps=24,settb=AVTB[${nextVideo}]`);
            if (document.base.hasAudio)
              filters.push(`[${audio}][a${index}]concat=n=2:v=0:a=1[${nextAudio}]`);
          }
          duration += segment.trimOut - segment.trimIn;
          video = nextVideo;
          audio = nextAudio;
        }
        const scale = Math.min(document.base.width / 1080, document.base.height / 1920);
        if (document.draft.textLayers.length) {
          const font = document.draft.brand?.font ?? 'sans';
          await prepareProductionFont(work, font);
          const text: ProductionTextLayer[] = document.draft.textLayers.map((layer) => {
            const fontSize = Math.max(12, Math.round(layer.fontSize * scale));
            return clampProductionText(
              {
                text: wrapProductionText(layer.text, (document.base.width - 96 * scale) / fontSize),
                start: layer.start,
                end: layer.end,
                x: document.base.width * layer.x,
                y: document.base.height * layer.y,
                fontName: productionFontName(font),
                fontSize,
                color: layer.color,
                alignment: 'center',
                box: { color: '#101010', opacity: 0.75, padding: 8 },
              },
              document.base.width,
              document.base.height,
            );
          });
          await writeFile(
            join(work, 'edit-text.ass'),
            productionTextAss(document.base.width, document.base.height, text),
            'utf8',
          );
          filters.push(`[${video}]ass=filename=edit-text.ass:fontsdir=.[textv]`);
          video = 'textv';
        }
        const baseOutput = document.draft.brand ? join(work, 'unbranded.mp4') : output;
        await runProductionFfmpeg(
          [
            ...inputs,
            '-filter_complex_threads',
            '1',
            '-filter_complex',
            filters.join(';'),
            '-map',
            `[${video}]`,
            ...(document.base.hasAudio ? ['-map', `[${audio}]`] : []),
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '21',
            '-threads',
            '2',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-t',
            String(duration),
            '-movflags',
            '+faststart',
            '-map_metadata',
            '-1',
            '-y',
            baseOutput,
          ],
          signal,
          work,
        );
        const metadata = {
          duration,
          width: document.base.width,
          height: document.base.height,
          hasAudio: document.base.hasAudio,
        };
        if (document.draft.brand) {
          const brand = await brands.verifySnapshot(document.draft.brand);
          await renderBrandMovie({
            input: baseOutput,
            output,
            directory: work,
            brand,
            ...(brand.logo ? { logoPath: brands.logoPath(brand.logo) } : {}),
            signal,
            metadata,
          });
        }
        const measured = await productionMovieReceipt(output, metadata, signal, work);
        const receipt = editRenderReceiptSchema.parse({
          ...measured,
          id: renderId,
          editVersion: document.version,
          baseJobId: document.base.jobId,
          createdAt: new Date().toISOString(),
        });
        await store.mutate((next) => {
          const record = find(next, sessionId, id);
          checkVersion(record.document, document.version);
          record.document.renders.push(receipt);
        });
        return receipt;
      } catch (error) {
        await rm(output, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        active = false;
        const within = relative(root, resolve(work));
        if (within && !within.startsWith('..') && !isAbsolute(within))
          await rm(work, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    async verifyOutput(sessionId: string, id: string, renderId: string) {
      const document = find(await store.read(), sessionId, id).document;
      const receipt = document.renders.find((item) => item.id === renderId);
      if (!receipt || receipt.editVersion !== document.version)
        throw new ApiError(
          409,
          'CREATOR_EDIT_STALE',
          'This export belongs to an older edit. Render the current version before downloading.',
        );
      const path = join(renders, `${receipt.id}.mp4`);
      await verifyProductionFile(path, receipt);
      return { path, receipt };
    },
  };
}
