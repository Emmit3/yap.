import { z } from 'zod';
import { socialHandoffSchema } from './social.js';

export const platformSchema = z.enum(['instagram', 'tiktok', 'youtube']);
export const toneSchema = z.enum(['conversational', 'educational', 'bold']);
export const goalSchema = z.enum(['educate', 'entertain', 'promote']);
export const durationSchema = z.union([z.literal(15), z.literal(30), z.literal(60)]);
export const statusSchema = z.enum(['draft', 'ready']);

export const projectBriefSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    idea: z.string().trim().min(10).max(4000),
    audience: z.string().trim().min(2).max(200),
    platform: platformSchema,
    duration: durationSchema,
    tone: toneSchema,
    goal: goalSchema,
  })
  .strict();

export const createProjectSchema = projectBriefSchema.extend({
  platform: platformSchema.default('instagram'),
  duration: durationSchema.default(30),
  tone: toneSchema.default('conversational'),
  goal: goalSchema.default('educate'),
  research: socialHandoffSchema.optional(),
});

export const shotSchema = z
  .object({
    id: z.string().min(1).max(100),
    seconds: z.number().int().min(1).max(60),
    visual: z.string().trim().min(1).max(1000),
    voiceover: z.string().trim().min(1).max(2000),
    onScreenText: z.string().max(300),
  })
  .strict();

export const draftContentSchema = z
  .object({
    hook: z.string().trim().min(1).max(1000),
    script: z.string().trim().min(1).max(10000),
    caption: z.string().max(3000),
    hashtags: z.array(z.string().max(100)).max(20),
    shots: z.array(shotSchema).min(1).max(12),
  })
  .strict();

export const videoDraftSchema = draftContentSchema.extend({
  provider: z.literal('guided'),
  generatedAt: z.iso.datetime(),
});

export const projectSchema = projectBriefSchema.extend({
  id: z.string().uuid(),
  status: statusSchema,
  draft: videoDraftSchema.nullable(),
  research: socialHandoffSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const updateProjectSchema = projectBriefSchema
  .partial()
  .extend({
    status: statusSchema.optional(),
    draft: draftContentSchema.optional(),
    research: socialHandoffSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.');

export const projectResponseSchema = z.object({ project: projectSchema });
export const projectsResponseSchema = z.object({ projects: z.array(projectSchema) });
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});

export type Platform = z.infer<typeof platformSchema>;
export type Tone = z.infer<typeof toneSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type Duration = z.infer<typeof durationSchema>;
export type ProjectStatus = z.infer<typeof statusSchema>;
export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type ProjectBrief = z.output<typeof createProjectSchema>;
export type DraftContent = z.infer<typeof draftContentSchema>;
export type VideoDraft = z.infer<typeof videoDraftSchema>;
export type Shot = z.infer<typeof shotSchema>;
export type Project = z.infer<typeof projectSchema>;
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
