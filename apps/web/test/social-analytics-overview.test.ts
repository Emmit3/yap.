import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { socialInvestigationSchema } from '@yap/contracts/social';
import AnalyticsOverview from '../src/social/AnalyticsOverview.js';
import {
  analyticsOverview,
  researchActivityStorageKey,
  researchContextSeed,
} from '../src/social/analytics-overview.js';

function investigation() {
  const posts = [
    {
      id: 'original',
      platform: 'x',
      url: 'https://x.com/creator/status/1',
      text: 'Which coffee habit would you change?',
      actorId: null,
      publishedAt: null,
      collectedAt: '2026-11-14T12:00:00.000Z',
      provider: 'x',
      contentKind: 'post',
      metrics: { likes: 0, replies: null, shares: null, views: null },
    },
    {
      id: 'excerpt',
      platform: 'web',
      url: 'https://example.org/coffee',
      text: 'A public coffee comparison excerpt.',
      actorId: null,
      publishedAt: '2026-11-13T10:00:00.000Z',
      collectedAt: '2026-11-15T12:00:00.000Z',
      provider: 'firecrawl',
      contentKind: 'search_result',
      metrics: { likes: null, replies: null, shares: null, views: null },
    },
  ];
  const finding = {
    id: 'question-angle',
    title: 'Test an audience question',
    description: 'A suggested framing choice supported by a returned source.',
    kind: 'opportunity',
    confidence: 'medium',
    evidenceIds: ['original', 'missing-source'],
    pros: ['The opening names a specific audience problem.'],
    cons: ['The sample does not establish why the post performed.'],
    scriptAngle: 'Ask one original audience question using the creator’s own facts.',
  };
  return socialInvestigationSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    topic: 'Coffee stories',
    audience: 'Home brewers',
    platforms: ['x', 'web', 'instagram'],
    mode: 'live',
    days: 7,
    limit: 60,
    createdAt: '2026-11-14T12:00:00.000Z',
    updatedAt: '2026-11-15T12:00:00.000Z',
    notes: [],
    analysis: {
      summary: 'Two returned public records inform a creative pattern within this sample.',
      posts,
      actors: [],
      relationships: [],
      communities: [],
      topics: [],
      rankedPosts: [],
      insights: [
        { ...finding, id: 'unsupported', kind: 'pattern', evidenceIds: ['missing-source'] },
        finding,
      ],
      timeline: [],
      graph: { nodes: [], edges: [], truncated: false },
      coverage: {
        postCount: 2,
        actorCount: 0,
        observedRelationshipCount: 0,
        inferredRelationshipCount: 1,
        postsWithMetrics: 1,
        postsWithTimestamps: 1,
        partial: true,
        warnings: ['Indexed coverage is incomplete.'],
      },
    },
  });
}

test('overview counts actual records, treats zero as a known metric, and separates source kinds and dates', () => {
  const overview = analyticsOverview(investigation());
  assert.equal(overview.illustrative, false);
  assert.equal(overview.withMetrics, 1);
  assert.equal(overview.withDates, 1);
  assert.equal(overview.completePosts, 1);
  assert.equal(overview.searchExcerpts, 1);
  assert.equal(overview.pages, 0);
  assert.deepEqual(overview.collection, {
    first: '2026-11-14T12:00:00.000Z',
    last: '2026-11-15T12:00:00.000Z',
  });
  assert.deepEqual(overview.publication, {
    first: '2026-11-13T10:00:00.000Z',
    last: '2026-11-13T10:00:00.000Z',
  });
  assert.equal(overview.platforms.find((item) => item.platform === 'instagram')?.count, 0);
  assert.equal(overview.featured?.id, 'question-angle');
  assert.deepEqual(
    overview.evidence.map((post) => post.id),
    ['original'],
  );
});

test('saved analytics render source caveats, interpretations, citation controls and persistent metadata without model work', () => {
  const html = renderToStaticMarkup(
    createElement(AnalyticsOverview, {
      investigation: investigation(),
      selectedInsightIds: ['question-angle'],
      disabled: true,
      onToggleInsight: () => {},
      onEvidence: () => {},
      onReviewFindings: () => {},
    }),
  );
  assert.match(html, /What this research suggests/);
  assert.match(html, /Potential strength/);
  assert.match(html, /Tradeoff/);
  assert.match(html, /Interpretation to review/);
  assert.match(html, /No observed public interactions were returned/);
  assert.match(html, /Collection window/);
  assert.match(html, /Reported publication window/);
  assert.match(html, /2026-11-13T10:00:00.000Z/);
  assert.match(html, /2026-11-15T12:00:00.000Z/);
  assert.match(html, /Instagram: 0 returned/);
  assert.match(html, /Inspect source 1/);
  assert.doesNotMatch(html, /Inspect source 2/);
  assert.match(html, /disabled=""/);
  assert.match(html, /checked=""/);
});

test('synthetic and empty evidence stay explicit and never manufacture publication or collection times', () => {
  const source = investigation();
  source.mode = 'demo';
  const demo = analyticsOverview(source);
  assert.equal(demo.illustrative, true);
  source.analysis.posts = [];
  source.analysis.insights = [];
  const empty = analyticsOverview(source);
  assert.equal(empty.collection, null);
  assert.equal(empty.publication, null);
  assert.equal(empty.featured, null);
  assert.deepEqual(empty.providers, []);
  const html = renderToStaticMarkup(
    createElement(AnalyticsOverview, {
      investigation: source,
      selectedInsightIds: [],
      disabled: false,
      onToggleInsight: () => {},
      onEvidence: () => {},
      onReviewFindings: () => {},
    }),
  );
  assert.match(html, /Illustrative evidence/);
  assert.match(html, /synthetic posts, accounts, dates, and metrics/);
  assert.match(html, /Not returned by the sources/);
});

test('mount context is bounded without broken Unicode and embedded activity is scoped away from other creations', () => {
  const seed = researchContextSeed('  Coffee stories  ', ' Home brewers ');
  assert.deepEqual(seed, { topic: 'Coffee stories', audience: 'Home brewers' });
  const unicode = researchContextSeed('🧪'.repeat(300), '咖'.repeat(600));
  assert.equal(unicode.topic.length, 300);
  assert.equal(unicode.audience.length, 500);
  assert.equal([...unicode.topic].length, 150);
  assert.equal(researchActivityStorageKey(false, seed), 'yap-active-research-run');
  const key = researchActivityStorageKey(true, seed);
  assert.equal(
    key,
    researchActivityStorageKey(true, researchContextSeed('Coffee stories', 'Home brewers')),
  );
  assert.notEqual(key, researchActivityStorageKey(true, { ...seed, topic: 'A different story' }));
  assert.notEqual(
    researchActivityStorageKey(true, seed, 'first'),
    researchActivityStorageKey(true, seed, 'second'),
  );
  assert.ok(!key.includes(seed.topic));
});
