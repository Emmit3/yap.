import { z } from 'zod';

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const brandLogoSchema = z
  .object({
    sha256: digest,
    bytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    width: z.number().int().positive().max(1024),
    height: z.number().int().positive().max(1024),
    mimeType: z.literal('image/png'),
  })
  .strict();
export const brandInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .max(80)
      .refine((text) => !/[\u0000-\u001f]/u.test(text), 'Keep the brand name on one line.'),
    font: z.enum(['sans', 'serif', 'mono']),
    inkColor: color,
    paperColor: color,
    accentColor: color,
    endCard: z
      .object({
        enabled: z.boolean(),
        title: z
          .string()
          .trim()
          .max(90)
          .refine(
            (text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text),
            'Remove control characters from the end card title.',
          ),
        detail: z
          .string()
          .trim()
          .max(160)
          .refine(
            (text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text),
            'Remove control characters from the end card text.',
          ),
        seconds: z.number().min(1).max(6),
      })
      .strict()
      .refine((card) => !card.enabled || Boolean(card.title), 'Give the enabled end card a title.'),
  })
  .strict();
export const brandSettingsSchema = brandInputSchema
  .extend({
    version: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
    logo: brandLogoSchema.nullable(),
  })
  .strict();
export const brandSnapshotSchema = brandSettingsSchema.extend({ sha256: digest }).strict();
export const brandUpdateSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    brand: brandInputSchema,
  })
  .strict();
export type BrandInput = z.infer<typeof brandInputSchema>;
export type BrandSettings = z.infer<typeof brandSettingsSchema>;
export type BrandSnapshot = z.infer<typeof brandSnapshotSchema>;
export type BrandLogo = z.infer<typeof brandLogoSchema>;

export const editSourceClipSchema = z
  .object({
    id: z.uuid(),
    start: z.number().nonnegative().max(120),
    end: z.number().positive().max(120),
  })
  .strict()
  .refine((value) => value.end > value.start, 'A source clip must have positive duration.');
export const editBaseFilmSchema = z
  .object({
    jobId: z.uuid(),
    sha256: digest,
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    duration: z.number().positive().max(120),
    width: z.number().int().min(256).max(4096),
    height: z.number().int().min(256).max(4096),
    hasAudio: z.boolean(),
    clips: z.array(editSourceClipSchema).min(1).max(24),
  })
  .strict()
  .superRefine((base, context) => {
    if (base.width * base.height > 9_000_000)
      context.addIssue({
        code: 'custom',
        message: 'The film dimensions exceed the local editor limit.',
      });
    const ids = new Set<string>();
    let at = 0;
    for (const [index, clip] of base.clips.entries()) {
      if (ids.has(clip.id) || Math.abs(clip.start - at) > 0.05 || clip.end > base.duration + 0.05)
        context.addIssue({
          code: 'custom',
          path: ['clips', index],
          message: 'Source clips must be unique and cover the original film in order.',
        });
      ids.add(clip.id);
      at = clip.end;
    }
    if (Math.abs(at - base.duration) > 0.05)
      context.addIssue({
        code: 'custom',
        path: ['clips'],
        message: 'Source clips must cover the whole original film.',
      });
  });
export const editSegmentSchema = z
  .object({
    id: z.uuid(),
    sourceClipId: z.uuid(),
    trimIn: z.number().nonnegative().max(120),
    trimOut: z.number().positive().max(120),
    transition: z.enum(['cut', 'dissolve']),
    transitionSeconds: z.number().min(0.1).max(1),
  })
  .strict()
  .refine(
    (value) => value.trimOut - value.trimIn >= 0.25,
    'Keep at least a quarter second of each clip.',
  );
export const editTextLayerSchema = z
  .object({
    id: z.uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine(
        (text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text),
        'Remove control characters from the text.',
      ),
    start: z.number().nonnegative().max(120),
    end: z.number().positive().max(120),
    x: z.number().min(0.05).max(0.95),
    y: z.number().min(0.05).max(0.95),
    fontSize: z.number().int().min(24).max(80),
    color,
  })
  .strict()
  .refine((value) => value.end > value.start, 'The text must finish after it starts.');
export const editDraftSchema = z
  .object({
    segments: z.array(editSegmentSchema).min(1).max(24),
    textLayers: z.array(editTextLayerSchema).max(24),
    brand: brandSnapshotSchema.nullable(),
  })
  .strict()
  .superRefine((draft, context) => {
    const ids = new Set<string>();
    for (const [index, segment] of draft.segments.entries()) {
      if (ids.has(segment.id))
        context.addIssue({
          code: 'custom',
          path: ['segments', index],
          message: 'Each edit segment needs its own identifier.',
        });
      ids.add(segment.id);
      const next = draft.segments[index + 1];
      if (
        next &&
        segment.transition === 'dissolve' &&
        segment.transitionSeconds >
          Math.min(segment.trimOut - segment.trimIn, next.trimOut - next.trimIn) / 2
      )
        context.addIssue({
          code: 'custom',
          path: ['segments', index, 'transitionSeconds'],
          message: 'A dissolve must fit inside both adjoining clips.',
        });
    }
    const duration = editDuration(draft);
    if (duration < 0.25 || duration > 120)
      context.addIssue({
        code: 'custom',
        path: ['segments'],
        message: 'Keep the edited film between a quarter second and two minutes.',
      });
    if (draft.textLayers.some((layer) => layer.end > duration + 0.001))
      context.addIssue({
        code: 'custom',
        path: ['textLayers'],
        message: 'Text layers must fit inside the edited film.',
      });
    if (new Set(draft.textLayers.map((layer) => layer.id)).size !== draft.textLayers.length)
      context.addIssue({
        code: 'custom',
        path: ['textLayers'],
        message: 'Each text layer needs its own identifier.',
      });
  });
export function editDuration(draft: {
  segments: Array<{
    trimIn: number;
    trimOut: number;
    transition: string;
    transitionSeconds: number;
  }>;
}): number {
  return draft.segments.reduce(
    (total, segment, index) =>
      total +
      segment.trimOut -
      segment.trimIn -
      (index < draft.segments.length - 1 && segment.transition === 'dissolve'
        ? segment.transitionSeconds
        : 0),
    0,
  );
}
export const editRenderReceiptSchema = z
  .object({
    id: z.uuid(),
    editVersion: z.number().int().positive(),
    baseJobId: z.uuid(),
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    sha256: digest,
    duration: z.number().positive().max(120),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    hasAudio: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const editDocumentSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    version: z.number().int().positive(),
    base: editBaseFilmSchema,
    draft: editDraftSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    renders: z.array(editRenderReceiptSchema).max(40),
  })
  .strict();
export const editUpdateSchema = z
  .object({ expectedVersion: z.number().int().positive(), draft: editDraftSchema })
  .strict();
export const editRenderSchema = z
  .object({ expectedVersion: z.number().int().positive(), reviewed: z.literal(true) })
  .strict();
export type EditBaseFilm = z.infer<typeof editBaseFilmSchema>;
export type EditDraft = z.infer<typeof editDraftSchema>;
export type EditDocument = z.infer<typeof editDocumentSchema>;
export type EditRenderReceipt = z.infer<typeof editRenderReceiptSchema>;
