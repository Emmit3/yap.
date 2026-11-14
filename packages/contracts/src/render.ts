import { z } from 'zod';
import { durationSchema } from './index.js';

const timestamp = z.iso.datetime();
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const renderRequestSchema = z.object({ expectedVersion: positiveInteger }).strict();

export const renderJobSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    workflowVersion: positiveInteger,
    sourceScenesId: z.uuid(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    width: z.literal(1080),
    height: z.literal(1920),
    duration: durationSchema,
    output: z
      .object({
        bytes: positiveInteger,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
    error: z
      .object({
        code: z.string().trim().min(1).max(120),
        message: z.string().trim().min(1).max(2000),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const renderJobResponseSchema = z.object({ job: renderJobSchema }).strict();
export const renderJobsResponseSchema = z
  .object({ jobs: z.array(renderJobSchema).max(1000) })
  .strict();

export type RenderRequestInput = z.infer<typeof renderRequestSchema>;
export type RenderJob = z.infer<typeof renderJobSchema>;
export type RenderJobResponse = z.infer<typeof renderJobResponseSchema>;
export type RenderJobsResponse = z.infer<typeof renderJobsResponseSchema>;
