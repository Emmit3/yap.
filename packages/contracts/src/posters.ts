import { z } from 'zod';

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
export const posterReferenceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const posterCategorySchema = z.enum(['party', 'music', 'popup', 'craft', 'market']);
export const posterSourceSchema = z
  .object({
    url: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.port &&
          url.hostname.includes('.') &&
          !/^[\d.]+$|[:\[\]]|\.(?:local|localhost)$/i.test(url.hostname)
        );
      }, 'Use a public HTTPS source URL without credentials.')
      .transform((value) => {
        const url = new URL(value);
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
          if (/^utm_/i.test(key) || /^(igsh|igshid|fbclid)$/i.test(key))
            url.searchParams.delete(key);
        }
        return url.href;
      }),
    timestampSeconds: z
      .number()
      .min(0)
      .max(24 * 60 * 60),
  })
  .strict();
export const posterObservedSchema = z
  .object({
    provenance: z.literal('visual_inspection'),
    layout: text(1200),
    typography: text(1000),
    palette: z.array(text(80)).min(1).max(8),
    imagery: text(1000),
    texture: text(500),
  })
  .strict();
export const posterReconstructionSchema = z
  .object({
    provenance: z.literal('authored_from_visual_reference'),
    instructions: z.array(text(1000)).min(1).max(8),
  })
  .strict();
const pixels = z.number().int().nonnegative();
export const posterReferenceSchema = z
  .object({
    id: posterReferenceIdSchema,
    title: text(200),
    category: posterCategorySchema.optional(),
    source: posterSourceSchema,
    imageUrl: z
      .string()
      .max(240)
      .regex(/^\/api\/posters\/references\/[a-z0-9][a-z0-9-]{0,79}\/image\?sha256=[a-f0-9]{64}$/),
    crop: z
      .object({
        reviewedPosterOnly: z.literal(true),
        reviewedAt: z.iso.datetime(),
        width: pixels.positive(),
        height: pixels.positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sourceFrame: z
          .object({ width: pixels.positive(), height: pixels.positive() })
          .strict()
          .optional(),
        bounds: z
          .object({
            left: pixels,
            top: pixels,
            width: pixels.positive(),
            height: pixels.positive(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    observed: posterObservedSchema,
    reconstruction: posterReconstructionSchema,
  })
  .strict()
  .refine(
    (reference) =>
      reference.imageUrl ===
      `/api/posters/references/${reference.id}/image?sha256=${reference.crop.sha256}`,
    'The image URL must match this reference and crop hash.',
  );
export const posterContextRequestSchema = z
  .object({ prompt: text(4000), referenceIds: z.array(posterReferenceIdSchema).min(1).max(3) })
  .strict()
  .refine(
    (request) => new Set(request.referenceIds).size === request.referenceIds.length,
    'Choose each reference once.',
  );
export const posterReferencesResponseSchema = z
  .object({ references: z.array(posterReferenceSchema).max(64) })
  .strict();
export const posterContextResponseSchema = z
  .object({
    prompt: text(64 * 1024),
    references: z.array(posterReferenceSchema).min(1).max(3),
    limitations: z.array(text(500)).max(8),
  })
  .strict();

export type PosterReference = z.infer<typeof posterReferenceSchema>;
export type PosterContext = z.infer<typeof posterContextResponseSchema>;
export type PosterContextRequest = z.infer<typeof posterContextRequestSchema>;
