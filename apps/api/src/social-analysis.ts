import { createHash } from 'node:crypto';
import {
  socialAnalysisSchema,
  socialDatasetSchema,
  socialHandoffSchema,
  socialQueryResponseSchema,
  type SocialAnalysis,
  type SocialCommunity,
  type SocialDataset,
  type SocialEvidence,
  type SocialGraphEdge,
  type SocialGraphNode,
  type SocialHandoff,
  type SocialHandoffInput,
  type SocialInsight,
  type SocialInvestigation,
  type SocialPost,
  type SocialQueryResponse,
  type SocialResearchInput,
  type SocialRelationship,
  type SocialTopic,
} from '@yap/contracts/social';
import { ApiError } from './errors.js';
import { removeSocialTracking } from './social-urls.js';

const STOP = new Set(
  'a an and are as at be been being but by can could did do does for from had has have how i if in into is it its just like may me more most my no not of on one or our out over own really she should so some than that the their them then there these they this those through to too under up us very was we were what when where which who why will with would you your about after before also only same still new get got make made use using via https http www com'.split(
    ' ',
  ),
);
const MAX_TOKENS = 64;
const MAX_CANDIDATES = 48;
const MAX_POSTING = 24;
const MAX_NODES = 250;
const MAX_EDGES = 600;

function key(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
function clipBytes(value: string, maxBytes: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) return normalized;
  let result = '';
  let bytes = 0;
  for (const character of normalized) {
    const next = Buffer.byteLength(character, 'utf8');
    if (bytes + next > maxBytes - 3) break;
    result += character;
    bytes += next;
  }
  return `${result}…`;
}
function sourceEvidence(post: SocialPost, excerpt: string): SocialEvidence {
  return {
    postId: post.id,
    url: post.url,
    excerpt,
    collectedAt: post.collectedAt,
    publishedAt: post.publishedAt,
    provider: post.provider,
    contentKind: post.contentKind,
  };
}
function tokens(value: string): string[] {
  return [
    ...new Set(
      (
        value
          .toLowerCase()
          .replace(/https?:\/\/\S+/g, ' ')
          .match(/[\p{L}\p{N}]{3,}/gu) ?? []
      ).filter((item) => !STOP.has(item)),
    ),
  ].slice(0, MAX_TOKENS);
}
function title(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
function canonical(value: string): string {
  const url = new URL(value);
  removeSocialTracking(url);
  const host = url.hostname.replace(/^www\./, '').replace(/^twitter\.com$/, 'x.com');
  return `${host}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}
type Pair = { a: string; b: string; weight: number };

/** Sparse, bounded lexical similarity. At most 48 candidate comparisons per post. */
function semanticPairs(posts: SocialPost[], terms: Map<string, string[]>): Pair[] {
  const index = new Map<string, number[]>();
  const documentFrequency = new Map<string, number>();
  for (const post of posts)
    for (const term of terms.get(post.id)!)
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const weight = (term: string) => Math.log(1 + posts.length / (documentFrequency.get(term) ?? 1));
  const vectors = new Map(
    posts.map((post) => [
      post.id,
      new Map(terms.get(post.id)!.map((term) => [term, weight(term)])),
    ]),
  );
  const norms = new Map(
    [...vectors].map(([id, vector]) => [
      id,
      Math.sqrt([...vector.values()].reduce((sum, n) => sum + n * n, 0)),
    ]),
  );
  const pairs = new Map<string, Pair>();
  posts.forEach((post, postIndex) => {
    const postTerms = [...terms.get(post.id)!].sort(
      (a, b) =>
        (documentFrequency.get(a) ?? 0) - (documentFrequency.get(b) ?? 0) || a.localeCompare(b),
    );
    const candidates = new Set<number>();
    for (const term of postTerms.slice(0, 12)) {
      for (const candidate of index.get(term) ?? []) {
        if (candidates.size < MAX_CANDIDATES) candidates.add(candidate);
      }
    }
    const nearest: Pair[] = [];
    for (const candidate of candidates) {
      const other = posts[candidate]!;
      const vector = vectors.get(post.id)!;
      const otherVector = vectors.get(other.id)!;
      let dot = 0;
      for (const [term, value] of vector) dot += value * (otherVector.get(term) ?? 0);
      const norm = norms.get(post.id)! * norms.get(other.id)!;
      const score = norm ? dot / norm : 0;
      if (score >= 0.28) nearest.push({ a: other.id, b: post.id, weight: score });
    }
    nearest.sort((a, b) => b.weight - a.weight || a.a.localeCompare(b.a));
    for (const pair of nearest.slice(0, 3)) pairs.set(`${pair.a}\u0000${pair.b}`, pair);
    for (const term of postTerms) {
      const list = index.get(term) ?? [];
      list.push(postIndex);
      if (list.length > MAX_POSTING) list.shift();
      index.set(term, list);
    }
  });
  return [...pairs.values()];
}

function groupPosts(
  posts: SocialPost[],
  relationships: SocialRelationship[],
  similarities: Pair[],
  terms: Map<string, string[]>,
): SocialCommunity[] {
  const adjacency = new Map(posts.map((post) => [post.id, new Map<string, number>()]));
  const byId = new Map(posts.map((post) => [post.id, post]));
  function join(a: string, b: string, weight: number) {
    if (a === b || !adjacency.has(a) || !adjacency.has(b)) return;
    for (const [source, target] of [
      [a, b],
      [b, a],
    ]) {
      const neighbors = adjacency.get(source!)!;
      neighbors.set(target!, (neighbors.get(target!) ?? 0) + weight);
    }
  }
  const authors = new Map<string, string[]>();
  for (const post of posts)
    if (post.actorId) {
      const entries = authors.get(post.actorId) ?? [];
      entries.push(post.id);
      authors.set(post.actorId, entries);
    }
  for (const entries of authors.values())
    for (let i = 1; i < entries.length; i += 1) join(entries[i - 1]!, entries[i]!, 2);
  for (const relationship of relationships) {
    if (relationship.targetPostId) join(relationship.sourcePostId, relationship.targetPostId, 3);
    else
      for (const target of (authors.get(relationship.targetActorId!) ?? []).slice(0, 12))
        join(relationship.sourcePostId, target, 1.5);
  }
  for (const pair of similarities) join(pair.a, pair.b, pair.weight * 0.45);
  const labels = new Map(posts.map((post) => [post.id, post.id]));
  const order = [...posts].sort(
    (a, b) => adjacency.get(b.id)!.size - adjacency.get(a.id)!.size || a.id.localeCompare(b.id),
  );
  // Fixed passes avoid unbounded convergence work. Structural links outweigh semantic ties.
  for (let iteration = 0; iteration < 8; iteration += 1) {
    let changed = false;
    for (const post of order) {
      const scores = new Map<string, number>();
      for (const [neighbor, weight] of adjacency.get(post.id)!) {
        const label = labels.get(neighbor)!;
        scores.set(label, (scores.get(label) ?? 0) + weight);
      }
      const current = labels.get(post.id)!;
      const ranked = [...scores].sort(
        (a, b) =>
          b[1] - a[1] || (a[0] === current ? -1 : b[0] === current ? 1 : a[0].localeCompare(b[0])),
      );
      if (ranked[0] && ranked[0][0] !== current) {
        labels.set(post.id, ranked[0][0]);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const groups = new Map<string, string[]>();
  for (const post of posts) {
    const label = labels.get(post.id)!;
    const entries = groups.get(label) ?? [];
    entries.push(post.id);
    groups.set(label, entries);
  }
  return [...groups.values()]
    .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!))
    .map((postIds) => {
      const frequencies = new Map<string, number>();
      for (const postId of postIds)
        for (const term of terms.get(postId)!)
          frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      const keywords = [...frequencies]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([term]) => term);
      const ids = new Set(postIds);
      const links = relationships.filter(
        (relation) =>
          ids.has(relation.sourcePostId) &&
          (relation.targetPostId
            ? ids.has(relation.targetPostId)
            : postIds.some((postId) => byId.get(postId)?.actorId === relation.targetActorId)),
      ).length;
      return {
        id: `community:${key([...postIds].sort().join('|'))}`,
        label: keywords.slice(0, 2).map(title).join(' · ') || 'Collected evidence',
        actorIds: unique(
          postIds.flatMap((postId) =>
            byId.get(postId)?.actorId ? [byId.get(postId)!.actorId!] : [],
          ),
        ),
        postIds,
        keywords,
        summary: `${postIds.length} collected item${postIds.length === 1 ? '' : 's'} grouped using public author identity, ${links} observed interaction${links === 1 ? '' : 's'}, and wording similarity. This is an estimated grouping within the sample.`,
      };
    });
}

function buildTopics(
  posts: SocialPost[],
  communities: SocialCommunity[],
  terms: Map<string, string[]>,
): SocialTopic[] {
  const index = new Map<string, string[]>();
  for (const post of posts)
    for (const term of terms.get(post.id)!) {
      const ids = index.get(term) ?? [];
      ids.push(post.id);
      index.set(term, ids);
    }
  const signatures = new Set<string>();
  const topics: SocialTopic[] = [];
  for (const [term, postIds] of [...index].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    if (postIds.length < 2) continue;
    const signature = [...postIds].sort().join('|');
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    topics.push({
      id: `topic:${key(term)}`,
      label: title(term),
      keywords: [term],
      postIds,
      communityIds: communities
        .filter((community) => community.postIds.some((postId) => postIds.includes(postId)))
        .map((community) => community.id),
    });
    if (topics.length === 6) break;
  }
  return topics;
}

function evidenceSignals(post: SocialPost): { strengths: string[]; cautions: string[] } {
  const strengths: string[] = [];
  const cautions: string[] = [];
  if (/\?/.test(post.text.slice(0, 180)))
    strengths.push('The opening asks a question the viewer can answer.');
  if (/\b\d+\b|first|second|step|three|five/i.test(post.text))
    strengths.push('Specific steps or numbers give the message a concrete structure.');
  if (/\bbut\b|instead|versus|\bvs\b|mistake|myth/i.test(post.text))
    strengths.push('The wording sets up a contrast or correction.');
  if (!strengths.length) strengths.push('A short opening can be reviewed as a framing reference.');
  if (post.metrics.shares !== null && post.metrics.shares > 0)
    strengths.push(
      `${post.metrics.shares.toLocaleString('en-US')} public shares or reposts were returned by the source.`,
    );
  cautions.push(
    'This sample does not establish why the content performed or provide a follower baseline.',
  );
  if (post.contentKind !== 'post')
    cautions.push(
      'Only a page or search excerpt was retrieved; review the original before using its framing.',
    );
  if (Object.values(post.metrics).every((value) => value === null))
    cautions.push('Engagement metrics are unavailable; popularity has not been measured.');
  if (!post.publishedAt)
    cautions.push(
      'Publication time is unavailable; the collection date is not a publication date.',
    );
  if (post.provider === 'demo')
    cautions.push('Illustrative demo content and metrics are not real public findings.');
  return { strengths, cautions };
}

function buildGraph(
  posts: SocialPost[],
  actors: SocialDataset['actors'],
  communities: SocialCommunity[],
  topics: SocialTopic[],
  insights: SocialInsight[],
  relationships: SocialRelationship[],
  similarities: Pair[],
  ranking: SocialAnalysis['rankedPosts'],
): SocialAnalysis['graph'] {
  const nodes: SocialGraphNode[] = [];
  const edges: SocialGraphEdge[] = [];
  const communityFor = new Map(
    communities.flatMap((community) =>
      community.postIds.map((postId) => [postId, community.id] as const),
    ),
  );
  const centers = new Map(
    communities.map((community, index) => {
      const angle = index * 2.399963;
      const radius = communities.length === 1 ? 0 : Math.min(330, 110 + 55 * Math.sqrt(index));
      return [
        community.id,
        { x: 500 + Math.cos(angle) * radius, y: 500 + Math.sin(angle) * radius },
      ];
    }),
  );
  const visibleCommunities = communities.slice(0, 12);
  const selectedPosts = ranking
    .slice(0, 150)
    .map((item) => posts.find((post) => post.id === item.postId)!);
  const selectedActors = actors
    .filter(
      (actor) =>
        selectedPosts.some((post) => post.actorId === actor.id) ||
        relationships.some(
          (relation) =>
            relation.targetActorId === actor.id &&
            selectedPosts.some((post) => post.id === relation.sourcePostId),
        ),
    )
    .slice(0, 60);
  const totalNodes =
    posts.length + actors.length + communities.length + topics.length + insights.length;
  const addNode = (node: SocialGraphNode) => {
    if (nodes.length < MAX_NODES) nodes.push(node);
  };
  const postNode = (id: string) => `post:${key(id)}`;
  const actorNode = (id: string) => `actor:${key(id)}`;
  for (const community of visibleCommunities) {
    const center = centers.get(community.id)!;
    addNode({
      id: community.id,
      kind: 'community',
      label: community.label,
      communityId: community.id,
      evidenceIds: community.postIds,
      weight: community.postIds.length,
      ...center,
    });
  }
  for (const post of selectedPosts) {
    const communityId = communityFor.get(post.id)!;
    const center = centers.get(communityId)!;
    const hash = parseInt(key(post.id).slice(0, 8), 16);
    const angle = (hash % 6283) / 1000;
    const radius = 48 + (hash % 72);
    addNode({
      id: postNode(post.id),
      kind: 'post',
      label: clip(post.text, 90),
      communityId,
      evidenceIds: [post.id],
      weight: ranking.find((item) => item.postId === post.id)?.score ?? 1,
      x: Math.max(30, Math.min(970, center.x + Math.cos(angle) * radius)),
      y: Math.max(30, Math.min(970, center.y + Math.sin(angle) * radius)),
    });
  }
  for (const actor of selectedActors) {
    const reference = relationships.find(
      (relation) =>
        relation.targetActorId === actor.id &&
        selectedPosts.some((post) => post.id === relation.sourcePostId),
    );
    const post =
      selectedPosts.find((item) => item.actorId === actor.id) ??
      selectedPosts.find((item) => item.id === reference?.sourcePostId)!;
    const center = centers.get(communityFor.get(post.id)!)!;
    const hash = parseInt(key(actor.id).slice(0, 8), 16);
    const angle = (hash % 6283) / 1000;
    addNode({
      id: actorNode(actor.id),
      kind: 'actor',
      label: actor.handle || actor.name,
      communityId: communityFor.get(post.id)!,
      evidenceIds: unique([
        ...posts.filter((item) => item.actorId === actor.id).map((item) => item.id),
        ...relationships
          .filter((relation) => relation.targetActorId === actor.id)
          .map((relation) => relation.sourcePostId),
      ]),
      weight: 2,
      x: Math.max(30, Math.min(970, center.x + Math.cos(angle) * 150)),
      y: Math.max(30, Math.min(970, center.y + Math.sin(angle) * 150)),
    });
  }
  topics.slice(0, 6).forEach((topic, index) =>
    addNode({
      id: topic.id,
      kind: 'topic',
      label: topic.label,
      communityId: null,
      evidenceIds: topic.postIds,
      weight: topic.postIds.length,
      x: 120 + index * 145,
      y: 60,
    }),
  );
  insights.slice(0, 6).forEach((insight, index) =>
    addNode({
      id: insight.id,
      kind: 'insight',
      label: insight.title,
      communityId: null,
      evidenceIds: insight.evidenceIds,
      weight: 3,
      x: 120 + index * 145,
      y: 930,
    }),
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  let candidateEdges = 0;
  const addEdge = (
    source: string,
    target: string,
    kind: SocialGraphEdge['kind'],
    observed: boolean,
    weight: number,
    evidenceIds: string[],
  ) => {
    candidateEdges += 1;
    if (edges.length < MAX_EDGES && nodeIds.has(source) && nodeIds.has(target))
      edges.push({
        id: `edge:${key(`${source}|${target}|${kind}`)}`,
        source,
        target,
        kind,
        observed,
        weight,
        evidenceIds,
      });
  };
  // Observed interactions go first so inferred display links never crowd them out.
  for (const relation of relationships)
    addEdge(
      postNode(relation.sourcePostId),
      relation.targetPostId ? postNode(relation.targetPostId) : actorNode(relation.targetActorId!),
      relation.kind,
      true,
      3,
      [relation.sourcePostId, ...(relation.targetPostId ? [relation.targetPostId] : [])],
    );
  for (const post of selectedPosts)
    if (post.actorId)
      addEdge(actorNode(post.actorId), postNode(post.id), 'authored', true, 1, [post.id]);
  for (const pair of similarities)
    addEdge(postNode(pair.a), postNode(pair.b), 'similarity', false, pair.weight, [pair.a, pair.b]);
  for (const topic of topics)
    for (const postId of topic.postIds.slice(0, 30))
      addEdge(topic.id, postNode(postId), 'topic', false, 0.5, [postId]);
  for (const community of visibleCommunities)
    for (const postId of community.postIds.slice(0, 30))
      addEdge(community.id, postNode(postId), 'topic', false, 0.4, [postId]);
  for (const insight of insights)
    for (const postId of insight.evidenceIds.slice(0, 8))
      addEdge(insight.id, postNode(postId), 'supports', false, 0.7, [postId]);
  return { nodes, edges, truncated: nodes.length < totalNodes || candidateEdges > edges.length };
}

/** Analyze only returned evidence. Unknown metrics, authors and times remain unknown. */
export function analyzeSocialDataset(
  input: SocialResearchInput,
  datasetInput: SocialDataset,
): SocialAnalysis {
  const dataset = socialDatasetSchema.parse(datasetInput);
  const warnings = [...dataset.warnings];
  const ids = new Set<string>();
  const urls = new Set<string>();
  const eligible = dataset.posts.filter((post) => {
    if (!input.platforms.includes(post.platform)) return false;
    const url = canonical(post.url);
    if (ids.has(post.id) || urls.has(url)) {
      warnings.push('Duplicate source items were omitted from analysis.');
      return false;
    }
    ids.add(post.id);
    urls.add(url);
    return true;
  });
  const posts = eligible.slice(0, input.limit);
  if (eligible.length > posts.length)
    warnings.push(
      `Analysis was capped at ${input.limit} items; the remaining returned items were omitted.`,
    );
  const postIds = new Set(posts.map((post) => post.id));
  const actorIds = new Set(posts.flatMap((post) => (post.actorId ? [post.actorId] : [])));
  for (const relationship of dataset.relationships)
    if (postIds.has(relationship.sourcePostId) && relationship.targetActorId)
      actorIds.add(relationship.targetActorId);
  const actors = [
    ...new Map(
      dataset.actors.filter((actor) => actorIds.has(actor.id)).map((actor) => [actor.id, actor]),
    ).values(),
  ];
  const knownActors = new Set(actors.map((actor) => actor.id));
  if (posts.some((post) => post.actorId && !knownActors.has(post.actorId)))
    warnings.push('Some source author IDs had no returned public profile metadata.');
  const relationshipKeys = new Set<string>();
  const relationships = dataset.relationships.filter((relation) => {
    if (!postIds.has(relation.sourcePostId)) return false;
    const resolved = relation.targetPostId
      ? postIds.has(relation.targetPostId)
      : knownActors.has(relation.targetActorId!);
    if (!resolved) {
      warnings.push(
        'Some observed references point outside the collected sample and are not drawn as complete network links.',
      );
      return false;
    }
    const signature = `${relation.sourcePostId}|${relation.targetPostId ?? relation.targetActorId}|${relation.kind}`;
    if (relationshipKeys.has(signature)) return false;
    relationshipKeys.add(signature);
    return true;
  });
  const terms = new Map(posts.map((post) => [post.id, tokens(post.text)]));
  const similarities = semanticPairs(posts, terms);
  const communities = groupPosts(posts, relationships, similarities, terms);
  const communityFor = new Map(
    communities.flatMap((community) =>
      community.postIds.map((postId) => [postId, community.id] as const),
    ),
  );
  const topics = buildTopics(posts, communities, terms);
  const incoming = new Map<string, number>();
  for (const relation of relationships)
    if (relation.targetPostId)
      incoming.set(relation.targetPostId, (incoming.get(relation.targetPostId) ?? 0) + 1);
  const engagement = (post: SocialPost) =>
    (post.metrics.likes ?? 0) + (post.metrics.replies ?? 0) + (post.metrics.shares ?? 0) * 2;
  const maxima = new Map(
    input.platforms.map((platform) => [
      platform,
      Math.max(
        1,
        ...posts
          .filter((post) => post.platform === platform)
          .map((post) => Math.log1p(engagement(post))),
      ),
    ]),
  );
  const theme = new Set(tokens(`${input.topic} ${input.audience}`));
  const maxIncoming = Math.max(1, ...incoming.values());
  const rankedPosts = posts
    .map((post) => {
      const hasMetrics =
        post.metrics.likes !== null ||
        post.metrics.replies !== null ||
        post.metrics.shares !== null;
      const hasNetwork = relationships.length > 0;
      const overlap = terms.get(post.id)!.filter((term) => theme.has(term)).length;
      const relevance = theme.size
        ? Math.min(1, overlap / Math.max(1, Math.min(theme.size, 5)))
        : 0.5;
      const measured = hasMetrics ? Math.log1p(engagement(post)) / maxima.get(post.platform)! : 0;
      const network = (incoming.get(post.id) ?? 0) / maxIncoming;
      const available = 0.35 + (hasMetrics ? 0.4 : 0) + (hasNetwork ? 0.25 : 0);
      const score = Math.round(
        (100 * (relevance * 0.35 + measured * 0.4 + network * 0.25)) / available,
      );
      return {
        postId: post.id,
        score,
        reason: `Ranked within the collected sample using topic relevance${hasMetrics ? ', returned engagement relative to this platform sample' : ''}${hasNetwork ? `, and ${incoming.get(post.id) ?? 0} observed incoming reference(s)` : ''}. This is not a universal virality score.`,
        communityId: communityFor.get(post.id) ?? null,
        ...evidenceSignals(post),
      };
    })
    .sort((a, b) => b.score - a.score || a.postId.localeCompare(b.postId));
  const insights: SocialInsight[] = [];
  const top = rankedPosts[0];
  if (top) {
    const post = posts.find((item) => item.id === top.postId)!;
    const question = /\?/.test(post.text.slice(0, 180));
    const contrast = /\bbut\b|instead|versus|\bvs\b|mistake|myth/i.test(post.text);
    insights.push({
      id: 'insight:opening',
      title: question
        ? 'Test a question in the opening'
        : contrast
          ? 'Test a clear contrast in the opening'
          : 'Start with one concrete audience problem',
      description: `The highest ranked item in this sample opens with: “${clip(post.text, 220)}” Its rank combines the available content and connectivity evidence; the opening alone does not explain performance.`,
      kind: 'opportunity',
      confidence: 'medium',
      evidenceIds: [post.id],
      pros: top.strengths,
      cons: top.cautions,
      scriptAngle: question
        ? `Open with an original question about ${input.topic} that ${input.audience || 'your audience'} can recognize, then answer it using your own verified facts.`
        : contrast
          ? `Frame an original before-and-after contrast about ${input.topic}; demonstrate the difference with your own evidence.`
          : `Name a specific ${input.topic} problem in the first spoken line, then show one practical response.`,
    });
  }
  if (posts.length)
    insights.push({
      id: 'insight:network',
      title: relationships.length
        ? 'Content and public connections tell different parts of the story'
        : 'The sample has a content layer; public connections are incomplete',
      description: relationships.length
        ? `${relationships.length} observed reply, quote, repost, or mention link(s) and ${similarities.length} inferred wording link(s) contribute to ${communities.length} estimated group(s). Structural links receive more weight than wording similarity. Groups describe this sample, not an entire platform.`
        : `${similarities.length} wording link(s) can organize the returned material, but no complete public interaction links were returned. A topical cluster is not evidence that accounts communicated or coordinated.`,
      kind: 'pattern',
      confidence: relationships.length ? 'medium' : 'low',
      evidenceIds: unique(
        relationships.length
          ? relationships.flatMap((relation) => [
              relation.sourcePostId,
              ...(relation.targetPostId ? [relation.targetPostId] : []),
            ])
          : posts.slice(0, 8).map((post) => post.id),
      ).slice(0, 30),
      pros: [
        relationships.length
          ? 'Observed amplification can help choose which examples to inspect.'
          : 'Semantic groups make a sparse sample easier to explore.',
      ],
      cons: [
        'Missing links and inaccessible accounts can change estimated communities.',
        'Similarity and timing do not establish intent, authenticity, or causality.',
      ],
      scriptAngle: `Use the vocabulary in a relevant audience group to explain ${input.topic}; preserve the distinction between public reaction and verified product facts.`,
    });
  const crossTopic = topics.find((topic) => topic.communityIds.length > 1);
  if (crossTopic)
    insights.push({
      id: 'insight:shared-language',
      title: `“${crossTopic.label}” appears across ${crossTopic.communityIds.length} estimated groups`,
      description:
        'The same term appears in separate groups inferred from authorship, observed interactions, and wording. This is an overlap in the sample; it does not prove that a narrative moved between those groups.',
      kind: 'opportunity',
      confidence: 'medium',
      evidenceIds: crossTopic.postIds.slice(0, 20),
      pros: ['A shared term can connect audience-specific examples in one explanation.'],
      cons: [
        'A shared word can have different meanings in different communities.',
        'A timeline shows when evidence was posted, not the causal route by which an idea spread.',
      ],
      scriptAngle: `Define what “${crossTopic.label.toLowerCase()}” means to your audience, then use a concrete original example instead of copying a popular post.`,
    });
  const mostReferenced = [...incoming].sort((a, b) => b[1] - a[1])[0];
  if (mostReferenced && mostReferenced[1] >= 2)
    insights.push({
      id: 'insight:amplification',
      title: 'One example attracts multiple visible references',
      description: `${mostReferenced[1]} collected posts publicly reference the same source item. Those links show observed amplification within this sample; they do not measure total reach.`,
      kind: 'pattern',
      confidence: 'high',
      evidenceIds: unique([
        mostReferenced[0],
        ...relationships
          .filter((relation) => relation.targetPostId === mostReferenced[0])
          .map((relation) => relation.sourcePostId),
      ]),
      pros: [
        'Direct references are stronger evidence of amplification than similar wording alone.',
      ],
      cons: [
        'Uncollected shares and private reactions are absent.',
        'A reference can criticize an idea as well as endorse it.',
      ],
      scriptAngle:
        'Identify the specific question people respond to, then answer that question in an original script with a clear demonstration.',
    });
  const byId = new Map(posts.map((post) => [post.id, post]));
  const linked = new Set(
    relationships.flatMap((relation) =>
      relation.targetPostId
        ? [
            `${relation.sourcePostId}|${relation.targetPostId}`,
            `${relation.targetPostId}|${relation.sourcePostId}`,
          ]
        : [],
    ),
  );
  const commonTargets = new Map<string, Set<string>>();
  for (const relation of relationships) {
    const target = relation.targetPostId ?? relation.targetActorId!;
    const sources = commonTargets.get(target) ?? new Set<string>();
    sources.add(relation.sourcePostId);
    commonTargets.set(target, sources);
  }
  const candidate = similarities.find((pair) => {
    const a = byId.get(pair.a)!;
    const b = byId.get(pair.b)!;
    return (
      pair.weight >= 0.82 &&
      a.actorId &&
      b.actorId &&
      a.actorId !== b.actorId &&
      a.publishedAt &&
      b.publishedAt &&
      Math.abs(Date.parse(a.publishedAt) - Date.parse(b.publishedAt)) <= 15 * 60 * 1000 &&
      (linked.has(`${pair.a}|${pair.b}`) ||
        [...commonTargets.values()].some((sources) => sources.has(pair.a) && sources.has(pair.b)))
    );
  });
  if (candidate)
    insights.push({
      id: 'insight:overlap-review',
      title: 'Review an overlap in timing, wording, and public links',
      description:
        'Two distinct public authors used very similar wording within 15 minutes and have a direct or shared public reference. This is a review cue. Ordinary reshares, scheduled campaigns, and news reactions can produce the same pattern; it is not a finding of bots or coordinated misconduct.',
      kind: 'coordination',
      confidence: 'low',
      evidenceIds: [candidate.a, candidate.b],
      pros: ['The cue combines content similarity, timing, and observed connectivity.'],
      cons: [
        'Intent and account authenticity cannot be inferred from this sample.',
        'The retrieval sample can omit earlier or independent examples.',
      ],
      scriptAngle:
        'Avoid treating repeated wording as independent proof. Prefer distinct examples and explain uncertainty when discussing a trend.',
    });
  const postsWithMetrics = posts.filter((post) =>
    Object.values(post.metrics).some((value) => value !== null),
  ).length;
  const postsWithTimestamps = posts.filter((post) => post.publishedAt !== null).length;
  if (!posts.length)
    warnings.push(
      'No public evidence matched the selected sources. Try a narrower topic or configure another provider.',
    );
  if (postsWithMetrics < posts.length)
    warnings.push(
      `${posts.length - postsWithMetrics} item(s) have no engagement metrics; missing values are not treated as zero engagement.`,
    );
  if (postsWithTimestamps < posts.length)
    warnings.push(
      `${posts.length - postsWithTimestamps} item(s) have no publication time and are excluded from the timeline.`,
    );
  if (posts.some((post) => post.contentKind !== 'post'))
    warnings.push(
      'Some evidence is a page or search excerpt. It does not supply complete post text or interaction history.',
    );
  if (!relationships.length && posts.length)
    warnings.push(
      'No complete observed public interaction links were collected. Wording links are inferred and do not establish communication.',
    );
  if (posts.some((post) => post.provider === 'demo'))
    warnings.push(
      'Demo evidence is illustrative. Accounts, posts, interactions, and metrics are not live findings.',
    );
  warnings.push(
    'This is a bounded public-data sample, not exhaustive platform coverage. Ranking does not predict reach or establish why a post performed.',
  );
  const timelineMap = new Map<string, { posts: number; communities: Map<string, number> }>();
  for (const post of posts)
    if (post.publishedAt) {
      const date = post.publishedAt.slice(0, 10);
      const entry = timelineMap.get(date) ?? { posts: 0, communities: new Map<string, number>() };
      entry.posts += 1;
      const group = communityFor.get(post.id)!;
      entry.communities.set(group, (entry.communities.get(group) ?? 0) + 1);
      timelineMap.set(date, entry);
    }
  const timeline = [...timelineMap]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({
      date,
      posts: value.posts,
      communities: [...value.communities].map(([communityId, count]) => ({ communityId, count })),
    }));
  const sampleKind = posts.every((post) => post.provider === 'demo')
    ? 'illustrative demo'
    : 'public';
  const summary = posts.length
    ? `${posts.length} ${sampleKind} evidence item${posts.length === 1 ? '' : 's'} about “${input.topic}” form ${communities.length} estimated group${communities.length === 1 ? '' : 's'} in this sample. ${relationships.length} observed interaction link${relationships.length === 1 ? '' : 's'} connect returned items or authors; ${similarities.length} additional links reflect similar wording. ${postsWithMetrics ? `${postsWithMetrics} items include returned engagement data, so ranking combines the available content and network signals.` : 'Engagement was not returned, so ranking reflects content relevance and available public links.'} Review each source before adopting a pattern.`
    : `No public evidence was returned for “${input.topic}”. Configure a source or adjust the topic to begin analysis.`;
  return socialAnalysisSchema.parse({
    methodology: {
      version: '1',
      content: 'Bounded binary TF-IDF cosine similarity',
      connectivity: 'Weighted label propagation; observed interactions outweigh similarity',
      retrieval: 'Lexical retrieval with one-hop observed reference context',
    },
    summary,
    posts,
    actors,
    relationships,
    communities,
    topics,
    rankedPosts,
    insights,
    timeline,
    graph: buildGraph(
      posts,
      actors,
      communities,
      topics,
      insights,
      relationships,
      similarities,
      rankedPosts,
    ),
    coverage: {
      postCount: posts.length,
      actorCount: actors.length,
      observedRelationshipCount: relationships.length,
      inferredRelationshipCount: similarities.length,
      postsWithMetrics,
      postsWithTimestamps,
      partial: true,
      warnings: unique(warnings).slice(0, 100),
    },
  });
}

/** Evidence retrieval with one-hop observed context; it does not pretend to be an LLM answer. */
export function querySocialAnalysis(
  analysis: SocialAnalysis,
  question: string,
): SocialQueryResponse {
  const queryTerms = new Set(tokens(question));
  const networkQuestion = /connect|amplif|repost|share|spread|communit|network|actor|account/i.test(
    question,
  );
  const creativeQuestion = /hook|script|opening|perform|best|work|pattern|lesson/i.test(question);
  const ranks = new Map(analysis.rankedPosts.map((item) => [item.postId, item.score]));
  const actorNames = new Map(
    analysis.actors.map((actor) => [actor.id, `${actor.name} ${actor.handle}`]),
  );
  const scored = analysis.posts
    .map((post) => {
      const postTerms = new Set(
        tokens(`${post.text} ${post.actorId ? (actorNames.get(post.actorId) ?? '') : ''}`),
      );
      const matches = [...queryTerms].filter((term) => postTerms.has(term)).length;
      const links = analysis.relationships.filter(
        (relation) => relation.sourcePostId === post.id || relation.targetPostId === post.id,
      ).length;
      return {
        post,
        score:
          matches * 10 +
          (networkQuestion ? links * 2 : 0) +
          (creativeQuestion ? (ranks.get(post.id) ?? 0) / 100 : 0),
        matches,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.post.id.localeCompare(b.post.id));
  const selected = scored.slice(0, 4).map((item) => item.post);
  const sourceIds = new Set(selected.map((post) => post.id));
  const contextIds = new Set<string>();
  for (const relation of analysis.relationships) {
    if (sourceIds.has(relation.sourcePostId) && relation.targetPostId)
      contextIds.add(relation.targetPostId);
    if (relation.targetPostId && sourceIds.has(relation.targetPostId))
      contextIds.add(relation.sourcePostId);
  }
  for (const post of analysis.posts)
    if (contextIds.has(post.id) && !sourceIds.has(post.id) && selected.length < 6) {
      selected.push(post);
      sourceIds.add(post.id);
    }
  const evidence = selected.map((post) => sourceEvidence(post, clip(post.text, 1200)));
  const relatedInsights = analysis.insights
    .filter((insight) => insight.evidenceIds.some((postId) => sourceIds.has(postId)))
    .slice(0, 2);
  const answer = selected.length
    ? `Retrieved ${selected.length} evidence item(s) matching your question${selected.some((post) => contextIds.has(post.id)) ? ', including one-hop public reference context' : ''}.\n\n${selected.map((post, index) => `[${index + 1}] ${post.actorId ? actorNames.get(post.actorId) || 'Public source' : 'Public source'}: ${clip(post.text, 650)}`).join('\n\n')}${relatedInsights.length ? `\n\nRelevant analysis:\n${relatedInsights.map((insight) => `${insight.title}: ${insight.description}`).join('\n\n')}` : ''}\n\nThis guided answer retrieves saved evidence. It does not establish intent, causal spread, or facts beyond the returned sources.`
    : 'The saved public evidence does not answer this question. Try a specific term, public author, opening, or observed reference in this investigation, or collect more evidence. No unsupported answer has been generated.';
  return socialQueryResponseSchema.parse({
    answer,
    evidence,
    relatedActorIds: unique(selected.flatMap((post) => (post.actorId ? [post.actorId] : []))),
    confidence: selected.length && scored.some((item) => item.matches > 0) ? 'medium' : 'low',
    limitations: analysis.coverage.warnings.slice(0, 100),
  });
}

/** Only creator-selected material crosses the research → script boundary. */
export function buildSocialHandoff(
  investigation: SocialInvestigation,
  input: SocialHandoffInput,
): SocialHandoff {
  const selectedNoteIds = unique(input.noteIds);
  const selectedInsightIds = unique(input.insightIds);
  if (!selectedNoteIds.length && !selectedInsightIds.length)
    throw new ApiError(
      400,
      'SOCIAL_SELECTION_REQUIRED',
      'Select an insight or a note before sending research to a script.',
    );
  const notes = selectedNoteIds.map((id) => {
    const item = investigation.notes.find((note) => note.id === id);
    if (!item)
      throw new ApiError(
        400,
        'SOCIAL_NOTE_NOT_FOUND',
        'A selected note is not part of this investigation.',
      );
    return item;
  });
  const insights = selectedInsightIds.map((id) => {
    const item = investigation.analysis.insights.find((insight) => insight.id === id);
    if (!item)
      throw new ApiError(
        400,
        'SOCIAL_INSIGHT_NOT_FOUND',
        'A selected insight is not part of this investigation.',
      );
    return item;
  });
  const evidenceIds = unique([
    ...notes.flatMap((note) => note.evidenceIds),
    ...insights.flatMap((insight) => insight.evidenceIds),
  ]);
  const sources = investigation.analysis.posts.filter((post) => evidenceIds.includes(post.id));
  if (evidenceIds.some((id) => !sources.some((post) => post.id === id)))
    throw new ApiError(
      409,
      'SOCIAL_EVIDENCE_MISSING',
      'Selected research points to evidence that is no longer available. Review the notes first.',
    );
  const maximumBytes = 48 * 1024;
  const material = [
    ...insights.map((insight) => ({
      prefix: 'Selected pattern',
      text: `${insight.title}. ${insight.scriptAngle}`,
    })),
    ...notes.map((note) => ({ prefix: title(note.kind), text: note.text })),
  ];
  let directionBudget = Math.min(1500, Math.max(48, Math.floor(10000 / material.length)));
  const allCautions = unique([
    ...investigation.analysis.coverage.warnings,
    ...insights.flatMap((insight) => insight.cons),
  ]);
  const cautions = allCautions.slice(0, 12).map((caution) => clipBytes(caution, 500));
  let bounded =
    sources.length > 100 ||
    cautions.length < allCautions.length ||
    allCautions.slice(0, 12).some((caution) => Buffer.byteLength(caution) > 500) ||
    material.some((item) => Buffer.byteLength(item.text) > directionBudget);
  const retainedSources = sources.slice(0, 100);
  let excerptBudget = 1200;
  let evidence = retainedSources.map((post) =>
    sourceEvidence(post, clipBytes(post.text, excerptBudget)),
  );
  if (retainedSources.some((post) => Buffer.byteLength(post.text) > excerptBudget)) bounded = true;
  const boundNotice =
    'Selected research was shortened for the 48 KB script handoff. Long note text, source excerpts, references, or caution details may be omitted here; review the saved investigation for the complete evidence.';
  const result = (): SocialHandoff => ({
    investigationId: investigation.id,
    topic: investigation.topic,
    audience: investigation.audience,
    creativeDirection: `Research topic: ${investigation.topic}\nAudience: ${investigation.audience || 'Use the creator’s existing audience.'}\n\n${material.map((item) => `${item.prefix}: ${clipBytes(item.text, directionBudget)}`).join('\n\n')}\n\nCreate original wording. Use this research to choose framing, structure, and questions; retain the creator’s verified product facts. Public popularity is not proof of a product claim or a promise of future reach.`,
    selectedNoteIds,
    selectedInsightIds,
    evidence,
    sourceUrls: unique(evidence.map((item) => item.url)),
    cautions: [...(bounded ? [boundNotice] : []), ...cautions],
  });
  const size = () => Buffer.byteLength(JSON.stringify(result()), 'utf8');
  // Measure the actual JSON wire representation, including escaping and multibyte text.
  while (size() > maximumBytes && excerptBudget > 48) {
    excerptBudget = Math.max(48, Math.floor(excerptBudget / 2));
    evidence = retainedSources.map((post) =>
      sourceEvidence(post, clipBytes(post.text, excerptBudget)),
    );
    bounded = true;
  }
  while (size() > maximumBytes && evidence.length) {
    evidence.pop();
    bounded = true;
  }
  while (size() > maximumBytes && cautions.length) {
    cautions.pop();
    bounded = true;
  }
  while (size() > maximumBytes && directionBudget > 12) {
    directionBudget = Math.max(12, Math.floor(directionBudget / 2));
    bounded = true;
  }
  if (size() > maximumBytes)
    throw new ApiError(
      413,
      'SOCIAL_HANDOFF_TOO_LARGE',
      'The selected research identifiers exceed the script context budget. Select fewer notes or insights.',
    );
  return socialHandoffSchema.parse(result());
}
