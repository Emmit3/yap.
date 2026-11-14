import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  socialResearchInputSchema,
  type SocialActor,
  type SocialDataset,
  type SocialInvestigation,
  type SocialPost,
} from '@yap/contracts/social';
import {
  analyzeSocialDataset,
  buildSocialHandoff,
  querySocialAnalysis,
} from '../src/social-analysis.js';

const now = '2026-11-13T10:00:00.000Z';
const input = socialResearchInputSchema.parse({
  topic: 'Coffee brewing',
  audience: 'Home coffee drinkers',
});
function post(id: string, text: string, changes: Partial<SocialPost> = {}): SocialPost {
  return {
    id,
    platform: 'x',
    url: `https://x.com/coffee/status/${id}`,
    text,
    actorId: `actor-${id}`,
    publishedAt: now,
    collectedAt: now,
    provider: 'x',
    contentKind: 'post',
    metrics: { likes: 10, shares: null, replies: null, views: null },
    ...changes,
  };
}
function data(posts: SocialPost[]): SocialDataset {
  return {
    posts,
    actors: posts.flatMap((item) =>
      item.actorId
        ? [
            {
              id: item.actorId,
              platform: item.platform,
              name: item.actorId,
              handle: `@${item.actorId}`,
              url: null,
            } satisfies SocialActor,
          ]
        : [],
    ),
    relationships: [],
    warnings: [],
  };
}
function investigation(dataset: SocialDataset): SocialInvestigation {
  return {
    ...input,
    id: randomUUID(),
    analysis: analyzeSocialDataset(input, dataset),
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
}

test('analysis combines actual amplification and wording without conflating observed and inferred links', () => {
  const dataset = data([
    post(
      'original',
      'Why does coffee taste bitter? Try a coarser grind and compare the next brew.',
    ),
    post('reply', 'Coffee tastes bitter with a fine grind. A coarser grind changed my next brew.'),
    post('repost', 'A coarser coffee grind changed the bitter taste of my morning brew.'),
  ]);
  dataset.relationships = [
    {
      id: 'r1',
      sourcePostId: 'reply',
      targetPostId: 'original',
      targetActorId: null,
      kind: 'reply',
      observedAt: now,
    },
    {
      id: 'r2',
      sourcePostId: 'repost',
      targetPostId: 'original',
      targetActorId: null,
      kind: 'repost',
      observedAt: now,
    },
  ];
  const result = analyzeSocialDataset(input, dataset);
  assert.equal(result.coverage.observedRelationshipCount, 2);
  assert.ok(result.coverage.inferredRelationshipCount > 0);
  assert.equal(
    result.graph.edges
      .filter((edge) => edge.kind === 'reply' || edge.kind === 'repost')
      .every((edge) => edge.observed),
    true,
  );
  assert.equal(
    result.graph.edges.filter((edge) => edge.kind === 'similarity').every((edge) => !edge.observed),
    true,
  );
  assert.equal(result.rankedPosts[0]?.postId, 'original');
  assert.ok(
    result.insights.some(
      (item) => item.id === 'insight:amplification' && item.evidenceIds.length === 3,
    ),
  );
  assert.match(result.summary, /observed interaction/);
  const ids = new Set(result.graph.nodes.map((node) => node.id));
  assert.ok(result.graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
});

test('missing metrics and timestamps stay unknown and do not become fake popularity or timeline events', () => {
  const dataset = data([
    post('unknown', 'Coffee brewing with a small kettle.', {
      metrics: { likes: null, replies: null, shares: null, views: null },
      publishedAt: null,
      provider: 'firecrawl',
      contentKind: 'search_result',
      actorId: null,
    }),
  ]);
  const result = analyzeSocialDataset(input, dataset);
  assert.equal(result.posts[0]?.metrics.likes, null);
  assert.equal(result.posts[0]?.publishedAt, null);
  assert.equal(result.coverage.postsWithMetrics, 0);
  assert.equal(result.coverage.postsWithTimestamps, 0);
  assert.deepEqual(result.timeline, []);
  assert.match(result.rankedPosts[0]!.cautions.join(' '), /popularity has not been measured/);
  assert.match(result.coverage.warnings.join(' '), /search excerpt/);
  assert.equal(
    result.insights.some((item) => item.kind === 'coordination'),
    false,
  );
});

test('same wording and timing alone do not trigger coordination; observed references are also required', () => {
  const dataset = data([
    post('a', 'Coffee brewing using a coarser grind gives a lighter cup.'),
    post('b', 'Coffee brewing using a coarser grind gives a lighter cup.'),
  ]);
  assert.equal(
    analyzeSocialDataset(input, dataset).insights.some((item) => item.kind === 'coordination'),
    false,
  );
  dataset.relationships = [
    {
      id: 'r',
      sourcePostId: 'b',
      targetPostId: 'a',
      targetActorId: null,
      kind: 'repost',
      observedAt: now,
    },
  ];
  const cue = analyzeSocialDataset(input, dataset).insights.find(
    (item) => item.kind === 'coordination',
  );
  assert.equal(cue?.confidence, 'low');
  assert.match(cue?.description ?? '', /not a finding of bots/);
  dataset.posts[1]!.actorId = dataset.posts[0]!.actorId;
  assert.equal(
    analyzeSocialDataset(input, dataset).insights.some((item) => item.kind === 'coordination'),
    false,
  );
});

test('a publicly mentioned actor remains visible even when none of their own posts were collected', () => {
  const dataset = data([post('mention', 'Coffee brewing inspired by this public account.')]);
  dataset.actors.push({
    id: 'mentioned-actor',
    platform: 'x',
    name: 'Public coffee account',
    handle: '@publiccoffee',
    url: 'https://x.com/publiccoffee',
  });
  dataset.relationships = [
    {
      id: 'mention-link',
      sourcePostId: 'mention',
      targetPostId: null,
      targetActorId: 'mentioned-actor',
      kind: 'mention',
      observedAt: now,
    },
  ];
  const result = analyzeSocialDataset(input, dataset);
  const actorNode = result.graph.nodes.find((node) => node.label === '@publiccoffee');
  assert.ok(actorNode);
  assert.ok(
    result.graph.edges.some(
      (edge) => edge.target === actorNode.id && edge.kind === 'mention' && edge.observed,
    ),
  );
});

test('canonical URL deduplication and incomplete reference coverage prevent invented boundary links', () => {
  const dataset = data([
    post('one', 'Coffee brewing basics.'),
    post('duplicate', 'Duplicate public item.', {
      url: 'https://twitter.com/coffee/status/one?tracking=1',
    }),
  ]);
  dataset.relationships = [
    {
      id: 'missing',
      sourcePostId: 'one',
      targetPostId: 'not-collected',
      targetActorId: null,
      kind: 'quote',
      observedAt: now,
    },
  ];
  const result = analyzeSocialDataset(input, dataset);
  assert.equal(result.posts.length, 1);
  assert.equal(result.relationships.length, 0);
  assert.equal(
    result.graph.edges.some((edge) => edge.kind === 'quote'),
    false,
  );
  assert.match(result.coverage.warnings.join(' '), /outside the collected sample/);
  assert.match(result.coverage.warnings.join(' '), /Duplicate/);
});

test('retrieval returns actual source citations plus one-hop observed public context', () => {
  const dataset = data([
    post('coffee', 'A tamper controls espresso puck density.'),
    post('related', 'This is a practical example of testing technique.'),
    post('other', 'A camera filming setup for an outdoor audience.'),
  ]);
  dataset.relationships = [
    {
      id: 'r',
      sourcePostId: 'related',
      targetPostId: 'coffee',
      targetActorId: null,
      kind: 'reply',
      observedAt: now,
    },
  ];
  const analysis = analyzeSocialDataset(input, dataset);
  const answer = querySocialAnalysis(analysis, 'What does the tamper control?');
  assert.deepEqual(
    new Set(answer.evidence.map((item) => item.postId)),
    new Set(['coffee', 'related']),
  );
  assert.ok(
    answer.evidence.every((item) =>
      dataset.posts.some((source) => source.id === item.postId && source.url === item.url),
    ),
  );
  assert.match(answer.answer, /one-hop/);
  const unavailable = querySocialAnalysis(analysis, 'quasiparticle superconductivity xenolith');
  assert.deepEqual(unavailable.evidence, []);
  assert.equal(unavailable.confidence, 'low');
  assert.match(unavailable.answer, /does not answer/);
});

test('only selected notes and patterns enter handoff, with original evidence and unknown ID rejection', () => {
  const item = investigation(data([post('a', 'Why is coffee bitter? Compare grind sizes.')]));
  const selectedId = randomUUID();
  item.notes = [
    {
      id: selectedId,
      text: 'Test an original comparison of our grind settings.',
      kind: 'test',
      evidenceIds: ['a'],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: randomUUID(),
      text: 'Secret unselected research note.',
      kind: 'context',
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
    },
  ];
  const output = buildSocialHandoff(item, {
    noteIds: [selectedId],
    insightIds: ['insight:opening'],
  });
  assert.deepEqual(output.selectedNoteIds, [selectedId]);
  assert.deepEqual(output.sourceUrls, ['https://x.com/coffee/status/a']);
  assert.match(output.creativeDirection, /original comparison/);
  assert.doesNotMatch(output.creativeDirection, /Secret unselected/);
  assert.match(output.creativeDirection, /verified product facts/);
  assert.throws(
    () => buildSocialHandoff(item, { noteIds: [], insightIds: [] }),
    /Select an insight/,
  );
  assert.throws(
    () => buildSocialHandoff(item, { noteIds: [], insightIds: ['missing'] }),
    /not part/,
  );
  assert.throws(
    () => buildSocialHandoff(item, { noteIds: [randomUUID()], insightIds: [] }),
    /not part/,
  );
});

test('empty analysis is usable and maximum dataset produces a bounded graph with no dangling edges', () => {
  const empty = analyzeSocialDataset(input, data([]));
  assert.equal(empty.coverage.postCount, 0);
  assert.deepEqual(empty.graph.nodes, []);
  assert.deepEqual(empty.insights, []);
  assert.match(empty.summary, /No public evidence/);
  const largeInput = socialResearchInputSchema.parse({ ...input, limit: 300 });
  const dataset = data(
    Array.from({ length: 300 }, (_, index) =>
      post(
        `p${index}`,
        `Coffee brewing method comparison number ${index} with a slow water pour and consistent grind size.`,
      ),
    ),
  );
  const result = analyzeSocialDataset(largeInput, dataset);
  assert.equal(result.posts.length, 300);
  assert.ok(result.graph.nodes.length <= 250);
  assert.ok(result.graph.edges.length <= 600);
  assert.equal(result.graph.truncated, true);
  assert.ok(result.coverage.inferredRelationshipCount <= 300 * 3);
  const ids = new Set(result.graph.nodes.map((node) => node.id));
  assert.ok(result.graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
  assert.equal(new Set(result.graph.edges.map((edge) => edge.id)).size, result.graph.edges.length);
});
