import { z } from 'zod';
import { workflowImageAssetSchema } from './workflow.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const creatorImageSettingsSchema = z
  .object({
    prompt: text(4000),
    model: z.enum(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']),
    quality: z.enum(['low', 'medium', 'high']),
    size: z.literal('864x1536'),
    complexity: z.literal('low'),
    clipId: z.uuid().optional(),
    parentVariantId: z.uuid().optional(),
    sourceAssetId: z.uuid().optional(),
  })
  .strict()
  .refine((input) => !(input.parentVariantId && input.sourceAssetId), {
    message: 'Choose one saved image or one uploaded reference.',
  });
export const creatorImageQuoteRequestSchema = z
  .object({
    expectedVersion: version,
    expectedWorkflowVersion: version,
    settings: creatorImageSettingsSchema,
  })
  .strict();
export const creatorImageQuoteSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    sessionVersion: version,
    workflowVersion: version,
    settings: creatorImageSettingsSchema,
    sourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    maxCostCents: z.number().int().positive().max(3000),
    currency: z.literal('USD'),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    consumedByJobId: z.uuid().nullable(),
  })
  .strict();
export const creatorImageStartSchema = z
  .object({
    expectedVersion: version,
    expectedWorkflowVersion: version,
    quoteId: z.uuid(),
    requestId: z.uuid(),
    costReviewed: z.literal(true),
  })
  .strict();
export const creatorImageJobSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    requestId: z.uuid(),
    quoteId: z.uuid(),
    sourceVersion: version,
    workflowVersion: version,
    settings: creatorImageSettingsSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    reservationId: z.uuid(),
    maxCostCents: z.number().int().positive().max(3000),
    submittedAt: z.iso.datetime().nullable(),
    variantId: z.uuid().nullable(),
    reportedCostCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    costWarning: text(1500).optional(),
    error: z
      .object({ code: text(100), message: text(1500) })
      .strict()
      .nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const creatorImageVariantSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    jobId: z.uuid(),
    kind: z.enum(['generated', 'edited']),
    settings: creatorImageSettingsSchema,
    sourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    media: workflowImageAssetSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export const creatorImageLibrarySchema = z
  .object({
    configured: z.boolean(),
    variants: z.array(creatorImageVariantSchema).max(120),
    jobs: z.array(creatorImageJobSchema).max(120),
  })
  .strict();
export const creatorImageJobResponseSchema = z.object({ job: creatorImageJobSchema }).strict();
export const creatorImageQuoteResponseSchema = z
  .object({ quote: creatorImageQuoteSchema })
  .strict();
export const creatorSelectKeyframeSchema = z
  .object({
    expectedVersion: version,
    expectedWorkflowVersion: version,
    planId: z.uuid(),
    clipId: z.uuid(),
    variantId: z.uuid().nullable(),
  })
  .strict();
export type CreatorImageSettings = z.infer<typeof creatorImageSettingsSchema>;
export type CreatorImageQuote = z.infer<typeof creatorImageQuoteSchema>;
export type CreatorImageJob = z.infer<typeof creatorImageJobSchema>;
export type CreatorImageVariant = z.infer<typeof creatorImageVariantSchema>;
export type CreatorImageLibrary = z.infer<typeof creatorImageLibrarySchema>;
export type CreatorImageQuoteRequest = z.infer<typeof creatorImageQuoteRequestSchema>;
export type CreatorImageStart = z.infer<typeof creatorImageStartSchema>;
