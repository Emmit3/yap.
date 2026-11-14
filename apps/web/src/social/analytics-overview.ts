import type { SocialInvestigation, SocialPost } from '@yap/contracts/social';

export function researchContextSeed(topic = '', audience = '') {
  const bound = (value: string, limit: number) => {
    let result = '';
    for (const character of value.trim()) {
      if (result.length + character.length > limit) break;
      result += character;
    }
    return result;
  };
  return { topic: bound(topic, 300), audience: bound(audience, 500) };
}

export function researchActivityStorageKey(
  embedded: boolean,
  seed: { topic: string; audience: string },
  investigationId?: string,
) {
  if (!embedded) return 'yap-active-research-run';
  const identity = investigationId ? `investigation:${investigationId}` : JSON.stringify(seed);
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index++)
    hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
  return `yap-active-research-run:embedded:${(hash >>> 0).toString(16)}`;
}

function dateRange(values: Array<string | null>) {
  const dates = values
    .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return dates.length ? { first: dates[0]!, last: dates[dates.length - 1]! } : null;
}

/** Describe returned source records, not selected platforms or inferred popularity. */
export function analyticsOverview(investigation: SocialInvestigation) {
  const { analysis } = investigation;
  const posts = new Map(analysis.posts.map((post) => [post.id, post]));
  const supported = analysis.insights.filter((insight) =>
    insight.evidenceIds.some((id) => posts.has(id)),
  );
  const featured =
    supported.find((insight) => insight.kind === 'opportunity') ?? supported[0] ?? null;
  const evidence = featured
    ? [...new Set(featured.evidenceIds)]
        .flatMap((id) => (posts.has(id) ? [posts.get(id)!] : []))
        .slice(0, 3)
    : [];
  const providers = new Map<SocialPost['provider'], number>();
  for (const post of analysis.posts)
    providers.set(post.provider, (providers.get(post.provider) ?? 0) + 1);
  return {
    illustrative:
      investigation.mode === 'demo' || analysis.posts.some((post) => post.provider === 'demo'),
    featured,
    evidence,
    providers: [...providers].map(([provider, count]) => ({ provider, count })),
    platforms: investigation.platforms.map((platform) => ({
      platform,
      count: analysis.posts.filter((post) => post.platform === platform).length,
    })),
    completePosts: analysis.posts.filter((post) => post.contentKind === 'post').length,
    searchExcerpts: analysis.posts.filter((post) => post.contentKind === 'search_result').length,
    pages: analysis.posts.filter((post) => post.contentKind === 'page').length,
    withMetrics: analysis.posts.filter((post) =>
      Object.values(post.metrics).some((value) => value !== null),
    ).length,
    withDates: analysis.posts.filter((post) => post.publishedAt !== null).length,
    collection: dateRange(analysis.posts.map((post) => post.collectedAt)),
    publication: dateRange(analysis.posts.map((post) => post.publishedAt)),
  };
}
