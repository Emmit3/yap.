import { z } from 'zod';

const uuid = z.uuid();
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime();
const text = (max: number) => z.string().trim().min(1).max(max);
export const creatorImageInputSchema = z
  .object({
    prompt: text(2000),
    purpose: z.enum(['storyboard', 'keyframe']),
    parentFrameId: uuid.optional(),
  })
  .strict();
export const creatorImageContextSchema = z
  .object({
    sessionId: uuid,
    sessionVersion: version,
    workflowVersion: version,
  })
  .strict();
export const creatorImageQuoteSchema = creatorImageContextSchema
  .extend({
    id: uuid,
    prompt: text(2000),
    promptHash: hash,
    inputHash: hash,
    purpose: z.enum(['storyboard', 'keyframe']),
    parentFrameId: uuid.optional(),
    parentFrameSha256: hash.optional(),
    model: z.literal('gpt-image-2-2026-04-21'),
    size: z.literal('1024x1536'),
    quality: z.literal('medium'),
    currency: z.literal('USD'),
    maxCostCents: z.literal(10),
    priceSourceUrl: z.literal('https://developers.openai.com/api/docs/guides/image-generation'),
    pricingCheckedAt: date,
    createdAt: date,
    expiresAt: date,
  })
  .strict();
export const creatorImageGenerateSchema = creatorImageContextSchema
  .omit({ sessionId: true })
  .extend({
    quoteId: uuid,
    requestId: uuid,
    reviewed: z.literal(true),
    costReviewed: z.literal(true),
  })
  .strict();
export const creatorImageJobSchema = z
  .object({
    id: uuid,
    sessionId: uuid,
    requestId: uuid,
    quoteId: uuid,
    inputHash: hash,
    promptHash: hash,
    prompt: text(2000),
    purpose: z.enum(['storyboard', 'keyframe']),
    parentFrameId: uuid.optional(),
    parentFrameSha256: hash.optional(),
    model: z.literal('gpt-image-2-2026-04-21'),
    attempt: z.number().int().min(1).max(2),
    status: z.enum(['running', 'succeeded', 'failed']),
    output: z
      .object({
        mimeType: z.literal('image/png'),
        bytes: z
          .number()
          .int()
          .min(100)
          .max(12 * 1024 * 1024),
        sha256: hash,
        width: z.literal(1024),
        height: z.literal(1536),
        provenance: z.literal('generated_openai_api'),
        providerRequestId: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    error: z
      .object({ code: text(100), message: text(1000) })
      .strict()
      .optional(),
    createdAt: date,
    updatedAt: date,
  })
  .strict();
export const publicReferenceUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value),
      host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      host.includes('.') &&
      !/(^localhost$|\.local$|\.internal$|^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.)/.test(
        host,
      )
    );
  }, 'Use a public HTTPS source page without credentials.');
export const referenceCueSchema = z
  .object({
    start: z.number().min(0).max(7200),
    end: z.number().positive().max(7200),
    text: text(2000),
  })
  .strict()
  .refine((cue) => cue.end > cue.start, 'A cue must end after it starts.');
export const referenceImportSchema = z
  .object({
    title: text(200),
    sourceUrl: publicReferenceUrlSchema,
    format: z.enum(['vtt', 'srt', 'plain']),
    transcript: text(64000),
  })
  .strict();
export const referenceFrameSchema = z
  .object({
    id: uuid,
    atSeconds: z.number().min(0).max(7200),
    mimeType: z.literal('image/jpeg'),
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024),
    sha256: hash,
    width: z.number().int().positive().max(1280),
    height: z.number().int().positive().max(1280),
  })
  .strict();
export const referenceAnalyzeSchema = z
  .object({
    expectedVersion: version,
    sourceHash: hash,
    requestId: uuid,
    reviewed: z.literal(true),
    costReviewed: z.literal(true),
    maxCostCents: z.literal(50),
  })
  .strict();
export const referenceObservationSchema = z
  .object({
    frameId: uuid.optional(),
    atSeconds: z.number().min(0).max(7200).optional(),
    text: text(2000),
    origin: z.enum(['creator', 'ai']),
  })
  .strict();
export const referenceAnalysisSchema = z
  .object({
    id: uuid,
    sessionId: uuid,
    version,
    title: text(200),
    sourceUrl: publicReferenceUrlSchema,
    transcriptFormat: z.enum(['vtt', 'srt', 'plain']),
    transcriptHash: hash,
    sourceHash: hash,
    cues: z.array(referenceCueSchema).max(1000),
    frames: z.array(referenceFrameSchema).max(8),
    observations: z.array(referenceObservationSchema).max(100),
    analysis: z
      .object({
        model: text(100),
        summary: text(6000),
        sourceHash: hash,
        analyzedAt: date,
        limitations: z.array(text(1000)).min(1).max(20),
      })
      .strict()
      .optional(),
    requests: z
      .array(
        z
          .object({
            requestId: uuid,
            sourceHash: hash,
            status: z.enum(['running', 'succeeded', 'failed']),
            createdAt: date,
            error: text(1000).optional(),
          })
          .strict(),
      )
      .max(100),
    provenance: z.literal('attributed_external_reference'),
    importedAt: date,
    updatedAt: date,
  })
  .strict();
export type CreatorImageInput = z.infer<typeof creatorImageInputSchema>;
export type CreatorImageContext = z.infer<typeof creatorImageContextSchema>;
export type CreatorImageQuote = z.infer<typeof creatorImageQuoteSchema>;
export type CreatorImageGenerate = z.infer<typeof creatorImageGenerateSchema>;
export type CreatorImageJob = z.infer<typeof creatorImageJobSchema>;
export type ReferenceImport = z.infer<typeof referenceImportSchema>;
export type ReferenceAnalysis = z.infer<typeof referenceAnalysisSchema>;
export type ReferenceFrame = z.infer<typeof referenceFrameSchema>;
export type ReferenceAnalyze = z.infer<typeof referenceAnalyzeSchema>;
