import { z } from 'zod';

const id = z.string().trim().min(1).max(300);
const timestamp = z.iso.datetime();
const text = z.string().trim().min(1);
const count = z.number().int().nonnegative();
const metric = z.number().nonnegative().nullable();
const publicUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      hostname.includes('.') &&
      !hostname.endsWith('.localhost') &&
      !hostname.endsWith('.local') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) &&
      !hostname.includes(':')
    );
  }, 'Use a public HTTPS URL without credentials.');

export const socialPlatformSchema = z.enum(['x', 'instagram', 'web']);
export const socialResearchInputSchema = z
  .object({
    topic: text.max(300),
    audience: z.string().trim().max(500).default(''),
    platforms: z
      .array(socialPlatformSchema)
      .min(1)
      .max(3)
      .refine((items) => new Set(items).size === items.length, 'Choose each platform once.')
      .default(['x', 'instagram', 'web']),
    mode: z.enum(['demo', 'live']).default('demo'),
    days: z.number().int().min(1).max(90).default(7),
    limit: z.number().int().min(1).max(300).default(60),
  })
  .strict();

export const socialActorSchema = z
  .object({
    id,
    platform: socialPlatformSchema,
    name: text.max(300),
    handle: z.string().max(300),
    url: publicUrl.nullable(),
  })
  .strict();
export const socialPostSchema = z
  .object({
    id,
    platform: socialPlatformSchema,
    url: publicUrl,
    text: text.max(12000),
    actorId: id.nullable(),
    publishedAt: timestamp.nullable(),
    collectedAt: timestamp,
    provider: z.enum(['demo', 'firecrawl', 'x', 'xai', 'instagram', 'import']),
    contentKind: z.enum(['post', 'search_result', 'page']),
    metrics: z.object({ likes: metric, replies: metric, shares: metric, views: metric }).strict(),
  })
  .strict();
export const socialRelationshipSchema = z
  .object({
    id,
    sourcePostId: id,
    targetPostId: id.nullable(),
    targetActorId: id.nullable(),
    kind: z.enum(['reply', 'repost', 'quote', 'mention']),
    observedAt: timestamp.nullable(),
  })
  .strict()
  .refine(
    (item) => item.targetPostId !== null || item.targetActorId !== null,
    'A relationship needs an observed target.',
  );
export const socialDatasetSchema = z
  .object({
    posts: z.array(socialPostSchema).max(300),
    actors: z.array(socialActorSchema).max(500),
    relationships: z.array(socialRelationshipSchema).max(1500),
    warnings: z.array(text.max(2000)).max(100),
  })
  .strict();
export const socialCommunitySchema = z
  .object({
    id,
    label: text.max(300),
    actorIds: z.array(id).max(500),
    postIds: z.array(id).max(300),
    keywords: z.array(text.max(100)).max(12),
    summary: text.max(2000),
  })
  .strict();
export const socialTopicSchema = z
  .object({
    id,
    label: text.max(300),
    keywords: z.array(text.max(100)).max(12),
    postIds: z.array(id).max(300),
    communityIds: z.array(id).max(300),
  })
  .strict();
export const socialInsightSchema = z
  .object({
    id,
    title: text.max(300),
    description: text.max(4000),
    kind: z.enum(['pattern', 'opportunity', 'coordination', 'coverage']),
    confidence: z.enum(['low', 'medium', 'high']),
    evidenceIds: z.array(id).max(300),
    pros: z.array(text.max(1000)).max(12),
    cons: z.array(text.max(1000)).max(12),
    scriptAngle: text.max(2000),
  })
  .strict();
export const socialGraphNodeSchema = z
  .object({
    id,
    kind: z.enum(['actor', 'post', 'topic', 'community', 'insight']),
    label: text.max(500),
    communityId: id.nullable(),
    evidenceIds: z.array(id).max(300),
    weight: z.number().nonnegative(),
    x: z.number().min(0).max(1000),
    y: z.number().min(0).max(1000),
  })
  .strict();
export const socialGraphEdgeSchema = z
  .object({
    id,
    source: id,
    target: id,
    kind: z.enum([
      'authored',
      'reply',
      'repost',
      'quote',
      'mention',
      'similarity',
      'topic',
      'supports',
    ]),
    observed: z.boolean(),
    weight: z.number().nonnegative(),
    evidenceIds: z.array(id).max(300),
  })
  .strict();
export const socialAnalysisSchema = z
  .object({
    methodology: z
      .object({
        version: text.max(80),
        content: text.max(200),
        connectivity: text.max(200),
        retrieval: text.max(200),
      })
      .strict()
      .optional(),
    summary: text.max(6000),
    posts: z.array(socialPostSchema).max(300),
    actors: z.array(socialActorSchema).max(500),
    relationships: z.array(socialRelationshipSchema).max(1500),
    communities: z.array(socialCommunitySchema).max(300),
    topics: z.array(socialTopicSchema).max(20),
    rankedPosts: z
      .array(
        z
          .object({
            postId: id,
            score: z.number().min(0).max(100),
            reason: text.max(2000),
            communityId: id.nullable(),
            strengths: z.array(text.max(1000)).max(12),
            cautions: z.array(text.max(1000)).max(12),
          })
          .strict(),
      )
      .max(300),
    insights: z.array(socialInsightSchema).max(30),
    timeline: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            posts: count,
            communities: z.array(z.object({ communityId: id, count }).strict()).max(300),
          })
          .strict(),
      )
      .max(300),
    graph: z
      .object({
        nodes: z.array(socialGraphNodeSchema).max(250),
        edges: z.array(socialGraphEdgeSchema).max(600),
        truncated: z.boolean(),
      })
      .strict(),
    coverage: z
      .object({
        postCount: count,
        actorCount: count,
        observedRelationshipCount: count,
        inferredRelationshipCount: count,
        postsWithMetrics: count,
        postsWithTimestamps: count,
        partial: z.boolean(),
        warnings: z.array(text.max(2000)).max(100),
      })
      .strict(),
  })
  .strict();

export const socialNoteInputSchema = z
  .object({
    text: text.max(4000),
    kind: z.enum(['adopt', 'avoid', 'test', 'context']),
    evidenceIds: z.array(id).max(100).default([]),
  })
  .strict();
export const socialNoteUpdateSchema = z
  .object({
    text: text.max(4000).optional(),
    kind: z.enum(['adopt', 'avoid', 'test', 'context']).optional(),
    evidenceIds: z.array(id).max(100).optional(),
  })
  .strict()
  .refine((item) => Object.keys(item).length > 0, 'Provide a note change.');
export const socialNoteSchema = socialNoteInputSchema
  .extend({ id: z.uuid(), createdAt: timestamp, updatedAt: timestamp })
  .strict();
export const socialInvestigationSchema = socialResearchInputSchema
  .extend({
    id: z.uuid(),
    createdAt: timestamp,
    updatedAt: timestamp,
    analysis: socialAnalysisSchema,
    notes: z.array(socialNoteSchema).max(100),
  })
  .strict();
export const socialInvestigationSummarySchema = socialInvestigationSchema.omit({
  analysis: true,
  notes: true,
});
export const socialInvestigationSummariesResponseSchema = z
  .object({ investigations: z.array(socialInvestigationSummarySchema).max(1000) })
  .strict();
export const socialQueryInputSchema = z.object({ question: text.max(2000) }).strict();
export const socialEvidenceSchema = z
  .object({
    postId: id,
    url: publicUrl,
    excerpt: text.max(1200),
    collectedAt: timestamp.optional(),
    publishedAt: timestamp.nullable().optional(),
    provider: socialPostSchema.shape.provider.optional(),
    contentKind: socialPostSchema.shape.contentKind.optional(),
  })
  .strict();
export const socialQueryResponseSchema = z
  .object({
    answer: text.max(12000),
    evidence: z.array(socialEvidenceSchema).max(12),
    relatedActorIds: z.array(id).max(100),
    confidence: z.enum(['low', 'medium', 'high']),
    limitations: z.array(text.max(2000)).max(100),
  })
  .strict();
export const socialHandoffInputSchema = z
  .object({
    noteIds: z.array(z.uuid()).max(100).default([]),
    insightIds: z.array(id).max(30).default([]),
  })
  .strict();
export const socialHandoffSchema = z
  .object({
    investigationId: z.uuid(),
    topic: text.max(300),
    audience: z.string().max(500),
    creativeDirection: text.max(16000),
    selectedNoteIds: z.array(z.uuid()).max(100),
    selectedInsightIds: z.array(id).max(30),
    evidence: z.array(socialEvidenceSchema).max(100),
    sourceUrls: z.array(publicUrl).max(100),
    cautions: z.array(text.max(2000)).max(100),
  })
  .strict();
export const socialProviderStatusSchema = z
  .object({
    id: z.enum(['firecrawl', 'x', 'xai']),
    name: text.max(100),
    configured: z.boolean(),
    platforms: z.array(socialPlatformSchema).max(3),
    description: text.max(1000),
    limitations: z.array(text.max(2000)).max(20),
  })
  .strict();
export const socialProvidersResponseSchema = z
  .object({ providers: z.array(socialProviderStatusSchema).max(10) })
  .strict();
export const socialInvestigationResponseSchema = z
  .object({ investigation: socialInvestigationSchema })
  .strict();
export const socialInvestigationsResponseSchema = z
  .object({ investigations: z.array(socialInvestigationSchema).max(1000) })
  .strict();

export const socialResearchHarnessSchema = z.enum(['pipeline', 'deepagents']);
export const socialResearchRunInputSchema = socialResearchInputSchema
  .extend({
    harness: socialResearchHarnessSchema.default('pipeline'),
  })
  .strict();
export const socialResearchArtifactPathSchema = z.enum([
  '/research/scope.json',
  '/research/sources.json',
  '/research/network.json',
  '/research/insights.json',
  '/research/brief.md',
]);
export const socialResearchEventInputSchema = z
  .object({
    agent: z.enum(['coordinator', 'source_researcher', 'network_analyst', 'creative_strategist']),
    task: z.enum(['scope', 'collect', 'normalize', 'analyze', 'brief', 'persist']),
    phase: z.enum(['started', 'progress', 'completed', 'failed', 'skipped']),
    message: text.max(500),
    provider: z.enum(['firecrawl', 'x', 'xai']).optional(),
    search: text.max(300).optional(),
    resultCount: count.max(300).optional(),
    artifactPath: socialResearchArtifactPathSchema.optional(),
    evidenceIds: z.array(id).max(20).optional(),
  })
  .strict();
export const socialResearchEventSchema = socialResearchEventInputSchema
  .extend({
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    at: timestamp,
  })
  .strict();
export const socialResearchArtifactSchema = z
  .object({
    path: socialResearchArtifactPathSchema,
    bytes: count.max(64 * 1024),
    updatedAt: timestamp,
  })
  .strict();
export const socialResearchArtifactResponseSchema = z
  .object({
    artifact: socialResearchArtifactSchema
      .extend({ content: z.string().max(64 * 1024), truncated: z.boolean() })
      .strict(),
  })
  .strict();
export const socialResearchRunSchema = z
  .object({
    id: z.uuid(),
    input: socialResearchRunInputSchema,
    status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']),
    canCancel: z.boolean(),
    execution: z.enum(['pipeline', 'deepagents', 'demo_replay']),
    createdAt: timestamp,
    updatedAt: timestamp,
    investigationId: z.uuid().nullable(),
    error: z
      .object({ code: text.max(120), message: text.max(1000) })
      .strict()
      .nullable(),
    events: z.array(socialResearchEventSchema).max(200),
    eventsTruncated: z.boolean(),
    lastSequence: count.max(Number.MAX_SAFE_INTEGER),
    artifacts: z.array(socialResearchArtifactSchema).max(5),
  })
  .strict();
export const socialResearchRunResponseSchema = z.object({ run: socialResearchRunSchema }).strict();
export const socialResearchCapabilitiesSchema = z
  .object({
    defaultHarness: socialResearchHarnessSchema,
    demoReplay: z.literal(true),
    pollIntervalMs: z.number().int().min(250).max(5000),
    harnesses: z
      .array(
        z
          .object({
            id: socialResearchHarnessSchema,
            name: text.max(100),
            configured: z.boolean(),
            description: text.max(1000),
            limitations: z.array(text.max(1000)).max(10),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export const socialResearchCapabilitiesResponseSchema = socialResearchCapabilitiesSchema;

export type SocialPlatform = z.infer<typeof socialPlatformSchema>;
export type SocialResearchInput = z.infer<typeof socialResearchInputSchema>;
export type SocialActor = z.infer<typeof socialActorSchema>;
export type SocialPost = z.infer<typeof socialPostSchema>;
export type SocialRelationship = z.infer<typeof socialRelationshipSchema>;
export type SocialDataset = z.infer<typeof socialDatasetSchema>;
export type SocialAnalysis = z.infer<typeof socialAnalysisSchema>;
export type SocialInsight = z.infer<typeof socialInsightSchema>;
export type SocialCommunity = z.infer<typeof socialCommunitySchema>;
export type SocialTopic = z.infer<typeof socialTopicSchema>;
export type SocialGraphNode = z.infer<typeof socialGraphNodeSchema>;
export type SocialGraphEdge = z.infer<typeof socialGraphEdgeSchema>;
export type SocialNote = z.infer<typeof socialNoteSchema>;
export type SocialNoteInput = z.infer<typeof socialNoteInputSchema>;
export type SocialNoteUpdate = z.infer<typeof socialNoteUpdateSchema>;
export type SocialInvestigation = z.infer<typeof socialInvestigationSchema>;
export type SocialInvestigationSummary = z.infer<typeof socialInvestigationSummarySchema>;
export type SocialQueryResponse = z.infer<typeof socialQueryResponseSchema>;
export type SocialEvidence = z.infer<typeof socialEvidenceSchema>;
export type SocialHandoffInput = z.infer<typeof socialHandoffInputSchema>;
export type SocialHandoff = z.infer<typeof socialHandoffSchema>;
export type SocialProviderStatus = z.infer<typeof socialProviderStatusSchema>;
export type SocialResearchHarness = z.infer<typeof socialResearchHarnessSchema>;
export type SocialResearchRunInput = z.infer<typeof socialResearchRunInputSchema>;
export type SocialResearchArtifactPath = z.infer<typeof socialResearchArtifactPathSchema>;
export type SocialResearchEventInput = z.infer<typeof socialResearchEventInputSchema>;
export type SocialResearchEvent = z.infer<typeof socialResearchEventSchema>;
export type SocialResearchArtifact = z.infer<typeof socialResearchArtifactSchema>;
export type SocialResearchRun = z.infer<typeof socialResearchRunSchema>;
export type SocialResearchCapabilities = z.infer<typeof socialResearchCapabilitiesSchema>;
