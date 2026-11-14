import { z } from 'zod';
import { durationSchema, platformSchema, toneSchema } from './index.js';
import { socialHandoffSchema } from './social.js';

const uuid = z.uuid();
const timestamp = z.iso.datetime();
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const workflowStageSchema = z.enum(['brief', 'script', 'scenes']);
export const workflowProviderSchema = z.enum(['guided', 'openai']);
export const workflowQuestionFieldSchema = z.enum([
  'productName',
  'productDescription',
  'audience',
  'keyBenefits',
  'callToAction',
  'imageDirection',
]);

/** An incomplete brief is valid while the creator is refining the idea. */
export const workflowBriefSchema = z
  .object({
    productName: z.string().trim().min(1).max(120).optional(),
    productDescription: z.string().trim().min(1).max(4000).optional(),
    audience: z.string().trim().min(1).max(500).optional(),
    keyBenefits: z.array(z.string().trim().min(1).max(500)).min(1).max(10).optional(),
    callToAction: z.string().trim().min(1).max(500).optional(),
    imageDirection: z.string().trim().min(1).max(2000).optional(),
    tone: toneSchema.optional(),
    platform: platformSchema.optional(),
    duration: durationSchema.optional(),
  })
  .strict();

export const workflowImageAssetSchema = z
  .object({
    id: uuid,
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(
        /^[^/\\\u0000-\u001f\u007f]+$/,
        'Use a filename without path separators or control characters.',
      ),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    bytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    width: z.number().int().positive().max(20000),
    height: z.number().int().positive().max(20000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    description: z.string().trim().max(2000),
    createdAt: timestamp,
  })
  .strict();

export const refinementQuestionSchema = z
  .object({
    id: workflowQuestionFieldSchema,
    field: workflowQuestionFieldSchema,
    status: z.enum(['open', 'answered']),
    question: z.string().trim().min(1).max(1000),
    answer: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

export const workflowMessageSchema = z
  .object({
    id: uuid,
    role: z.enum(['user', 'assistant']),
    kind: z.enum(['input', 'refinement', 'query']),
    text: z.string().trim().min(1).max(12000),
    createdAt: timestamp,
  })
  .strict();

export const workflowScriptSegmentSchema = z
  .object({
    id: uuid,
    text: z.string().trim().min(1).max(2000),
    seconds: z.number().int().min(1).max(60),
  })
  .strict();

export const workflowScriptSchema = z
  .object({
    id: uuid,
    sourceRevision: version,
    hook: z.string().trim().min(1).max(1000),
    segments: z.array(workflowScriptSegmentSchema).min(1).max(12),
    caption: z.string().max(3000),
    provider: workflowProviderSchema,
    createdAt: timestamp,
  })
  .strict();

export const workflowSceneSchema = z
  .object({
    id: uuid,
    scriptSegmentId: uuid,
    seconds: z.number().int().min(1).max(60),
    visual: z.string().trim().min(1).max(2000),
    onScreenText: z.string().max(500),
    assetIds: z.array(uuid).max(20),
  })
  .strict();

export const workflowScenesSchema = z
  .object({
    id: uuid,
    sourceScriptId: uuid,
    scenes: z.array(workflowSceneSchema).min(1).max(24),
    provider: workflowProviderSchema,
    createdAt: timestamp,
  })
  .strict();

export const workflowApprovalsSchema = z
  .object({
    brief: version.nullable(),
    script: uuid.nullable(),
    scenes: uuid.nullable(),
  })
  .strict();

export const workflowSchema = z
  .object({
    id: uuid,
    version,
    contentRevision: version,
    title: z.string().trim().min(1).max(120),
    input: z.string().trim().min(1).max(8000),
    research: socialHandoffSchema.optional(),
    brief: workflowBriefSchema,
    assets: z.array(workflowImageAssetSchema).max(20),
    messages: z.array(workflowMessageSchema).max(200),
    questions: z.array(refinementQuestionSchema).max(6),
    script: workflowScriptSchema.nullable(),
    scenes: workflowScenesSchema.nullable(),
    approvals: workflowApprovalsSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const workflowCheckSchema = z
  .object({
    code: z.string().trim().min(1).max(120),
    passed: z.boolean(),
    severity: z.enum(['error', 'warning']),
    message: z.string().trim().min(1).max(2000),
    path: z.string().max(300).optional(),
  })
  .strict();

export const workflowStageVerificationSchema = z
  .object({
    stage: workflowStageSchema,
    state: z.enum(['blocked', 'needs_review', 'approved']),
    checks: z.array(workflowCheckSchema).max(200),
    canApprove: z.boolean(),
  })
  .strict();

export const workflowVerificationSchema = z
  .object({
    brief: workflowStageVerificationSchema,
    script: workflowStageVerificationSchema,
    scenes: workflowStageVerificationSchema,
  })
  .strict();

export const createWorkflowSchema = z
  .object({
    input: z.string().trim().min(1).max(8000),
    research: socialHandoffSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    brief: workflowBriefSchema.optional(),
  })
  .strict();

const answersSchema = z
  .object({
    productName: z.string().trim().min(1).max(120).optional(),
    productDescription: z.string().trim().min(1).max(4000).optional(),
    audience: z.string().trim().min(1).max(500).optional(),
    keyBenefits: z.string().trim().min(1).max(4000).optional(),
    callToAction: z.string().trim().min(1).max(500).optional(),
    imageDirection: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one answer.');

const briefChangesSchema = workflowBriefSchema.refine(
  (value) => Object.keys(value).length > 0,
  'Provide at least one brief field.',
);

export const refineWorkflowSchema = z
  .object({
    expectedVersion: version,
    message: z.string().trim().min(1).max(8000).optional(),
    answers: answersSchema.optional(),
    brief: briefChangesSchema.optional(),
    research: socialHandoffSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.message !== undefined || value.answers !== undefined || value.brief !== undefined || value.research !== undefined,
    'Provide a message, answers, or brief changes.',
  );

export const generateWorkflowSchema = z.object({ expectedVersion: version }).strict();

export const updateWorkflowScriptSchema = z
  .object({
    expectedVersion: version,
    hook: z.string().trim().min(1).max(1000),
    segments: z.array(workflowScriptSegmentSchema).min(1).max(12),
    caption: z.string().max(3000),
  })
  .strict();

export const updateWorkflowScenesSchema = z
  .object({
    expectedVersion: version,
    scenes: z.array(workflowSceneSchema).min(1).max(24),
  })
  .strict();

export const approveWorkflowStageSchema = z
  .object({
    expectedVersion: version,
    stage: workflowStageSchema,
  })
  .strict();

export const queryWorkflowSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
  })
  .strict();

export const updateAssetDescriptionSchema = z
  .object({
    expectedVersion: version,
    description: z.string().trim().max(2000),
  })
  .strict();

export const workflowQueryEvidenceSchema = z
  .object({
    kind: z.enum(['brief', 'asset', 'script', 'scene']),
    id: uuid.optional(),
    field: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const workflowQueryResponseSchema = z
  .object({
    answer: z.string().trim().min(1).max(12000),
    evidence: z.array(workflowQueryEvidenceSchema).max(100),
    openQuestions: z.array(refinementQuestionSchema).max(6),
    workflowVersion: version,
    provider: workflowProviderSchema,
  })
  .strict();

export const workflowResponseSchema = z
  .object({
    workflow: workflowSchema,
    verification: workflowVerificationSchema,
  })
  .strict();

export const workflowsResponseSchema = z
  .object({
    workflows: z.array(workflowSchema).max(1000),
  })
  .strict();

export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type WorkflowProvider = z.infer<typeof workflowProviderSchema>;
export type WorkflowQuestionField = z.infer<typeof workflowQuestionFieldSchema>;
export type WorkflowBrief = z.infer<typeof workflowBriefSchema>;
export type WorkflowImageAsset = z.infer<typeof workflowImageAssetSchema>;
export type RefinementQuestion = z.infer<typeof refinementQuestionSchema>;
export type WorkflowMessage = z.infer<typeof workflowMessageSchema>;
export type WorkflowScriptSegment = z.infer<typeof workflowScriptSegmentSchema>;
export type WorkflowScript = z.infer<typeof workflowScriptSchema>;
export type WorkflowScene = z.infer<typeof workflowSceneSchema>;
export type WorkflowScenes = z.infer<typeof workflowScenesSchema>;
export type WorkflowApprovals = z.infer<typeof workflowApprovalsSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowCheck = z.infer<typeof workflowCheckSchema>;
export type WorkflowStageVerification = z.infer<typeof workflowStageVerificationSchema>;
export type WorkflowVerification = z.infer<typeof workflowVerificationSchema>;
export type WorkflowQueryEvidence = z.infer<typeof workflowQueryEvidenceSchema>;
export type WorkflowQueryResponse = z.infer<typeof workflowQueryResponseSchema>;
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type RefineWorkflowInput = z.infer<typeof refineWorkflowSchema>;
export type GenerateWorkflowInput = z.infer<typeof generateWorkflowSchema>;
export type UpdateWorkflowScriptInput = z.infer<typeof updateWorkflowScriptSchema>;
export type UpdateWorkflowScenesInput = z.infer<typeof updateWorkflowScenesSchema>;
export type ApproveWorkflowStageInput = z.infer<typeof approveWorkflowStageSchema>;
export type QueryWorkflowInput = z.infer<typeof queryWorkflowSchema>;
export type UpdateAssetDescriptionInput = z.infer<typeof updateAssetDescriptionSchema>;
