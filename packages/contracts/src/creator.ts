import { z } from 'zod';
import { workflowSchema } from './workflow.js';
import { socialHandoffSchema } from './social.js';
import { durationSchema, platformSchema, toneSchema } from './index.js';

const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === 'https:', 'Use a public HTTPS URL.');
export const creatorInputSchema = z
  .object({
    mode: z.enum(['media', 'text']),
    prompt: text(8000),
    location: text(200).optional(),
    urls: z.array(httpsUrl).max(5).default([]),
    platform: platformSchema.optional(),
    duration: durationSchema.optional(),
    tone: toneSchema.optional(),
  })
  .strict();
export const creatorAnswerSchema = z.object({ questionId: text(80), answer: text(2000) }).strict();
export const creatorQuestionSchema = z
  .object({ id: text(80), question: text(500), why: text(500) })
  .strict();
export const creatorSourceSchema = z
  .object({
    id: text(80),
    url: httpsUrl,
    title: text(200),
    kind: z.enum(['cinematography', 'social', 'product', 'github', 'location']),
    excerpt: text(1500),
    platform: z.enum(['x', 'tiktok', 'instagram', 'web']).optional(),
    provider: z.enum(['firecrawl', 'github', 'creator']).optional(),
    collectedAt: z.iso.datetime().optional(),
    publishedAt: z.iso.datetime().nullable().optional(),
    contentKind: z.enum(['search_result', 'page', 'repository']).optional(),
  })
  .strict();
export const creatorReferenceSchema = z
  .object({
    id: text(80),
    sourceIds: z.array(text(80)).min(1).max(8),
    title: text(200),
    hook: text(1000),
    visualDirection: text(2000),
    rationale: text(1000),
  })
  .strict();
export const creatorResearchSchema = z
  .object({
    summary: text(3000),
    productFacts: z.array(text(1000)).max(20),
    cinematography: z.string().max(6000),
    sources: z.array(creatorSourceSchema).max(40),
    references: z.array(creatorReferenceSchema).max(12),
    questions: z.array(creatorQuestionSchema).max(8),
    limitations: z.array(text(1000)).max(20),
    coverage: z
      .array(
        z
          .object({
            branch: z.enum(['cinematography', 'x', 'tiktok', 'instagram', 'context']),
            status: z.enum(['available', 'empty', 'unavailable', 'failed', 'partial']),
            message: text(1000),
          })
          .strict(),
      )
      .max(5)
      .optional(),
  })
  .strict();
export const creatorExternalReferenceSchema = z
  .object({
    id: text(120),
    title: text(200),
    brand: text(200).optional(),
    creator: text(200).optional(),
    url: httpsUrl,
    watchUrl: httpsUrl,
    techniques: z.array(text(500)).max(12),
    whyItFits: text(2000),
    evidence: text(2000),
    usage: z.literal('external_reference'),
    verifiedAt: z.iso.datetime().optional(),
  })
  .strict();
export const creatorClipSchema = z
  .object({
    id: z.uuid(),
    sceneId: z.uuid(),
    seconds: z.number().int().min(2).max(10),
    prompt: text(1000),
    camera: text(1000),
    lighting: text(1000),
    assetId: z.uuid().optional(),
    referenceIds: z.array(text(120)).max(12).optional(),
  })
  .strict();
export const creatorVoiceSchema = z.enum([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]);
/** Narration voice and bundled music bed. Null means that layer is off. */
export const creatorAudioSchema = z
  .object({ voice: creatorVoiceSchema.nullable(), musicTrackId: text(80).nullable() })
  .strict();
const audioConsistent = (value: { hasAudio: boolean; audio?: CreatorAudio | undefined }) =>
  value.hasAudio === Boolean(value.audio?.voice || value.audio?.musicTrackId);
export const creatorPlanSchema = z
  .object({
    id: z.uuid(),
    workflowVersion: version,
    scriptId: z.uuid(),
    sourceScenesId: z.uuid(),
    caption: z.string().max(3000),
    clips: z.array(creatorClipSchema).min(1).max(12),
    provider: z.enum(['runway', 'fal']).optional(),
    model: z.enum(['gen4.5', 'seedance-v1.5-pro']),
    ratio: z.literal('720:1280'),
    // Generated clips stay silent. This describes the assembled film's added soundtrack.
    hasAudio: z.boolean(),
    audio: creatorAudioSchema.optional(),
    maxAttemptsPerClip: z.literal(2),
    maxGeneratedSeconds: z.number().int().positive().max(120),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .refine(audioConsistent, 'The audio settings do not match hasAudio.');
export const creatorApprovalSchema = z
  .object({
    id: z.uuid(),
    planId: z.uuid(),
    workflowVersion: version,
    approvedAt: z.iso.datetime(),
    quoteId: z.uuid().optional(),
  })
  .strict();
export const creatorSessionSchema = z
  .object({
    id: z.uuid(),
    version,
    workflowId: z.uuid(),
    input: creatorInputSchema,
    answers: z.array(creatorAnswerSchema).max(20),
    research: creatorResearchSchema.nullable(),
    selectedReferenceIds: z.array(text(80)).max(12),
    externalReferences: z.array(creatorExternalReferenceSchema).max(12).default([]),
    plan: creatorPlanSchema.nullable(),
    approval: creatorApprovalSchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const creatorAuditSchema = z
  .object({
    technicalPassed: z.boolean(),
    visionPassed: z.boolean().nullable(),
    summary: text(3000),
    issues: z.array(text(1000)).max(12),
  })
  .strict();
export const creatorClipReceiptSchema = z
  .object({
    clipId: z.uuid(),
    attempt: z.number().int().min(1).max(2),
    providerTaskId: z.string().max(200).nullable(),
    status: z.enum(['queued', 'generating', 'auditing', 'passed', 'failed']),
    audit: creatorAuditSchema.nullable(),
    prompt: z.string().max(1000).optional(),
    reservationId: z.uuid().optional(),
    output: z
      .object({ bytes: version, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict();
export const creatorJobSchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    sessionId: z.uuid(),
    kind: z.enum(['analysis', 'production']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    phase: z.enum(['queued', 'research', 'generating', 'auditing', 'assembling', 'complete']),
    sourceVersion: version,
    workflowVersion: version,
    approvalId: z.uuid().nullable(),
    quoteId: z.uuid().optional(),
    planId: z.uuid().optional(),
    reservationIds: z.array(z.uuid()).max(12).optional(),
    audioReservationId: z.uuid().optional(),
    // Set before the first narration request so an untouched hold can be released.
    audioStarted: z.boolean().optional(),
    clips: z.array(creatorClipReceiptSchema).max(24),
    events: z.array(z.object({ at: z.iso.datetime(), message: text(1000) }).strict()).max(100),
    output: z
      .object({
        bytes: version,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        duration: z.number().positive(),
        width: z.literal(1080),
        height: z.literal(1920),
        hasAudio: z.boolean(),
      })
      .strict()
      .nullable(),
    error: z
      .object({ code: text(120), message: text(2000) })
      .strict()
      .nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const createCreatorSessionSchema = z
  .object({
    input: creatorInputSchema,
    workflowId: z.uuid().optional(),
    research: socialHandoffSchema.optional(),
    externalReferences: z.array(creatorExternalReferenceSchema).max(12).optional(),
  })
  .strict();
export const patchCreatorSessionSchema = z
  .object({
    expectedVersion: version,
    input: creatorInputSchema.optional(),
    answers: z.array(creatorAnswerSchema).max(20).optional(),
    selectedReferenceIds: z.array(text(80)).max(12).optional(),
    externalReferences: z.array(creatorExternalReferenceSchema).max(12).optional(),
  })
  .strict();
export const creatorVersionRequestSchema = z.object({ expectedVersion: version }).strict();
export const creatorPrepareSchema = z
  .object({ expectedVersion: version, expectedWorkflowVersion: version })
  .strict();
export const creatorUpdatePlanSchema = creatorPrepareSchema.extend({
  clips: z.array(creatorClipSchema).min(1).max(12),
  caption: z.string().max(3000),
  audio: creatorAudioSchema.optional(),
});
export const creatorApproveSchema = creatorPrepareSchema.extend({
  planId: z.uuid(),
  reviewed: z.literal(true),
  quoteId: z.uuid(),
  costReviewed: z.literal(true),
});
export const creatorProduceSchema = z
  .object({
    expectedVersion: version,
    approvalId: z.uuid(),
    quoteId: z.uuid(),
    requestId: z.uuid(),
  })
  .strict();
export const creatorSessionResponseSchema = z
  .object({ session: creatorSessionSchema, workflow: workflowSchema })
  .strict();
export const creatorJobResponseSchema = z
  .object({ job: creatorJobSchema, session: creatorSessionSchema })
  .strict();
export const creatorCapabilitiesSchema = z
  .object({
    configured: z.boolean(),
    researchConfigured: z.boolean(),
    visionConfigured: z.boolean(),
    provider: z.enum(['runway', 'fal']),
    model: z.enum(['gen4.5', 'seedance-v1.5-pro']),
    hasAudio: z.boolean(),
    voiceoverConfigured: z.boolean(),
    voices: z.array(creatorVoiceSchema).max(13),
    musicTracks: z
      .array(
        z
          .object({
            id: text(80),
            title: text(200),
            mood: text(40),
            description: text(200),
            seconds: z.number().positive(),
          })
          .strict(),
      )
      .max(20),
    maxAttemptsPerClip: z.literal(2),
    maxGeneratedSeconds: z.literal(120),
    reason: z.string().max(1000),
  })
  .strict();

const cents = z.number().int().nonnegative().max(1_000_000);
export const creatorBudgetSchema = z
  .object({
    scope: z.literal('creator_app'),
    currency: z.literal('USD'),
    limitCents: cents,
    reservedCents: cents,
    chargedCents: cents,
    availableCents: cents,
  })
  .strict();
export const creatorQuoteSchema = z
  .object({
    estimateKind: z.literal('conservative_ceiling'),
    id: z.uuid(),
    sessionId: z.uuid(),
    sessionVersion: version,
    workflowVersion: version,
    planId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    provider: z.enum(['runway', 'fal']),
    model: z.enum(['gen4.5', 'seedance-v1.5-pro']),
    ratio: z.literal('720:1280'),
    hasAudio: z.boolean(),
    audio: creatorAudioSchema.optional(),
    // Narration ceiling for the whole film. Bundled music is free. Absent on older quotes.
    audioCents: cents.default(0),
    narratedSegments: z.number().int().nonnegative().max(60).default(0),
    currency: z.literal('USD'),
    maxCostCents: cents,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    approvedApprovalId: z.uuid().nullable(),
    consumedByJobId: z.uuid().nullable(),
    clips: z
      .array(
        z
          .object({
            clipId: z.uuid(),
            seconds: z.number().int().min(2).max(10),
            attempt: z.number().int().min(1).max(2),
            videoCents: cents,
            visionCents: cents,
            costCents: cents,
            reuse: z
              .object({
                jobId: z.uuid(),
                attempt: z.number().int().min(1).max(2),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export const creatorQuoteResponseSchema = z
  .object({ quote: creatorQuoteSchema, budget: creatorBudgetSchema })
  .strict();
export const creatorBudgetResponseSchema = z.object({ budget: creatorBudgetSchema }).strict();
export type CreatorQuote = z.infer<typeof creatorQuoteSchema>;
export type CreatorBudgetSnapshot = z.infer<typeof creatorBudgetSchema>;

export type CreatorInput = z.infer<typeof creatorInputSchema>;
export type CreatorAnswer = z.infer<typeof creatorAnswerSchema>;
export type CreatorQuestion = z.infer<typeof creatorQuestionSchema>;
export type CreatorSource = z.infer<typeof creatorSourceSchema>;
export type CreatorReference = z.infer<typeof creatorReferenceSchema>;
export type CreatorExternalReference = z.infer<typeof creatorExternalReferenceSchema>;
export type CreatorResearch = z.infer<typeof creatorResearchSchema>;
export type CreatorClip = z.infer<typeof creatorClipSchema>;
export type CreatorVoice = z.infer<typeof creatorVoiceSchema>;
export type CreatorAudio = z.infer<typeof creatorAudioSchema>;
export type CreatorPlan = z.infer<typeof creatorPlanSchema>;
export type CreatorApproval = z.infer<typeof creatorApprovalSchema>;
export type CreatorSession = z.infer<typeof creatorSessionSchema>;
export type CreatorAudit = z.infer<typeof creatorAuditSchema>;
export type CreatorJob = z.infer<typeof creatorJobSchema>;
export type CreatorSessionResponse = z.infer<typeof creatorSessionResponseSchema>;
export type CreatorJobResponse = z.infer<typeof creatorJobResponseSchema>;
export type CreatorCapabilities = z.infer<typeof creatorCapabilitiesSchema>;
export type CreateCreatorSessionInput = z.input<typeof createCreatorSessionSchema>;
export type PatchCreatorSessionInput = z.infer<typeof patchCreatorSessionSchema>;
export type CreatorPrepareInput = z.infer<typeof creatorPrepareSchema>;
export type CreatorUpdatePlanInput = z.infer<typeof creatorUpdatePlanSchema>;
export type CreatorApproveInput = z.infer<typeof creatorApproveSchema>;
export type CreatorProduceInput = z.infer<typeof creatorProduceSchema>;
