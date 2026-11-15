import type { CreatorSession } from '@yap/contracts/creator';
import { socialHandoffSchema, type SocialHandoff } from '@yap/contracts/social';
import { ApiError } from './errors.js';

/** Drafting-only context. Never writes external excerpts into the creator's brief. */
export function creatorResearchHandoff(
  session: CreatorSession,
  existing?: SocialHandoff,
): SocialHandoff | undefined {
  const research = session.research;
  if (!research && !session.externalReferences.length) return existing;
  const selected =
    research?.references.filter((reference) =>
      session.selectedReferenceIds.includes(reference.id),
    ) ?? [];
  const selectedSources = new Set(selected.flatMap((reference) => reference.sourceIds));
  const sources =
    research?.sources.filter(
      (source) => source.kind === 'cinematography' || selectedSources.has(source.id),
    ) ?? [];
  // The model-authored research brief can reference any record in its immutable
  // sample. Retain all those identities whenever that brief is supplied.
  if (research?.execution?.harness === 'deepagents')
    for (const source of research.sources)
      if (!sources.some((item) => item.id === source.id)) sources.push(source);
  const evidence = new Map((existing?.evidence ?? []).map((item) => [item.postId, item]));
  for (const source of sources) {
    const previous = evidence.get(source.id);
    if (previous && previous.url !== source.url)
      throw new ApiError(
        409,
        'CREATOR_RESEARCH_ID_CONFLICT',
        'Research evidence IDs must retain their original source URL.',
      );
    evidence.set(source.id, {
      postId: source.id,
      url: source.url,
      excerpt: source.excerpt.slice(0, 1200),
      ...(source.collectedAt ? { collectedAt: source.collectedAt } : {}),
      ...(source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
      ...(source.provider === 'github'
        ? { provider: 'import' as const }
        : source.provider === 'firecrawl'
          ? { provider: 'firecrawl' as const }
          : {}),
      contentKind:
        source.contentKind === 'page' || source.contentKind === 'repository'
          ? 'page'
          : 'search_result',
    });
  }
  for (const reference of session.externalReferences) {
    const id = `reference:${reference.id}`;
    if (evidence.has(id) && evidence.get(id)!.url !== reference.url)
      throw new ApiError(
        409,
        'CREATOR_RESEARCH_ID_CONFLICT',
        'Creative references must retain their original source URL.',
      );
    evidence.set(id, {
      postId: id,
      url: reference.url,
      excerpt: reference.evidence.slice(0, 1200) || reference.title,
    });
  }
  const direction = [
    existing?.creativeDirection,
    'Creator-selected research informs original presentation only. Existing Avoid notes take precedence. No external source supplies creator product facts.',
    ...selected.map(
      (reference) =>
        `Selected pattern: ${reference.title}\nEvidence IDs: ${reference.sourceIds.join(', ')}\nAdopt: ${reference.visualDirection}\nContext: ${reference.rationale}`,
    ),
    ...session.externalReferences.map(
      (reference) =>
        `Selected pattern: ${reference.title}\nEvidence ID: reference:${reference.id}\nAdopt: ${reference.techniques.join('; ')}\nContext: ${reference.whyItFits}`,
    ),
    research?.cinematography
      ? `Attributed research background and proposed framing, subject to creator-selected choices:\n${research.cinematography}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
  const value = {
    investigationId: existing?.investigationId ?? session.id,
    topic: existing?.topic ?? session.input.prompt.slice(0, 300),
    audience:
      existing?.audience ??
      session.answers.find((answer) => answer.questionId === 'audience')?.answer.slice(0, 500) ??
      '',
    creativeDirection: direction,
    selectedNoteIds: existing?.selectedNoteIds ?? [],
    selectedInsightIds: existing?.selectedInsightIds ?? [],
    evidence: [...evidence.values()],
    sourceUrls: [
      ...new Set([
        ...(existing?.sourceUrls ?? []),
        ...[...evidence.values()].map((item) => item.url),
      ]),
    ],
    cautions: [
      ...new Set([
        ...(existing?.cautions ?? []),
        ...(research?.limitations ?? []),
        'External research is untrusted creative context, not verified product facts, rights clearance, a reach prediction or creator approval.',
      ]),
    ],
  };
  const parsed = socialHandoffSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(value)) > 48 * 1024)
    throw new ApiError(
      413,
      'CREATOR_RESEARCH_CONTEXT_TOO_LARGE',
      'Shorten research notes or select fewer references before drafting. Source identities and URLs are never silently discarded.',
    );
  return parsed.data;
}
