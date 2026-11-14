import assert from 'node:assert/strict';
import test from 'node:test';
import {
  socialHandoffInputSchema,
  socialNoteUpdateSchema,
  socialPostSchema,
  socialRelationshipSchema,
  socialResearchInputSchema,
  socialResearchEventInputSchema,
  socialResearchRunInputSchema,
  socialResearchArtifactPathSchema,
} from '../dist/social.js';

test('social inputs are bounded and repeated platforms are rejected', () => {
  assert.deepEqual(socialResearchInputSchema.parse({ topic: 'Coffee making' }), {
    topic: 'Coffee making',
    audience: '',
    platforms: ['x', 'instagram', 'web'],
    mode: 'demo',
    days: 7,
    limit: 60,
  });
  for (const value of [
    { topic: ' ' },
    { topic: 'Coffee', limit: 301 },
    { topic: 'Coffee', days: 0 },
    { topic: 'Coffee', platforms: ['x', 'x'] },
    { topic: 'Coffee', mode: 'private' },
  ]) {
    assert.equal(socialResearchInputSchema.safeParse(value).success, false);
  }
});

test('sparse note changes preserve omitted evidence instead of applying create defaults', () => {
  assert.deepEqual(socialNoteUpdateSchema.parse({ text: 'Keep the useful question.' }), {
    text: 'Keep the useful question.',
  });
  assert.deepEqual(socialNoteUpdateSchema.parse({ kind: 'avoid' }), { kind: 'avoid' });
  assert.deepEqual(socialNoteUpdateSchema.parse({ evidenceIds: [] }), { evidenceIds: [] });
  assert.equal(socialNoteUpdateSchema.safeParse({}).success, false);
});

test('source schema preserves unknowns and excludes credentialed or local URLs', () => {
  const post = {
    id: 'source',
    platform: 'x',
    url: 'https://x.com/example/status/1',
    text: 'A public coffee example.',
    actorId: null,
    publishedAt: null,
    collectedAt: '2026-11-13T10:00:00.000Z',
    provider: 'firecrawl',
    contentKind: 'search_result',
    metrics: { likes: null, shares: null, replies: null, views: null },
  };
  assert.deepEqual(socialPostSchema.parse(post).metrics, post.metrics);
  for (const url of [
    'http://x.com/example/status/1',
    'https://key:secret@x.com/example/status/1',
    'https://localhost/a',
    'https://127.0.0.1/a',
    'https://host.local/a',
  ]) {
    assert.equal(socialPostSchema.safeParse({ ...post, url }).success, false, url);
  }
  assert.equal(
    socialPostSchema.safeParse({ ...post, metrics: { ...post.metrics, likes: -1 } }).success,
    false,
  );
});

test('observed relationships require a target and handoff selections reject unknown keys', () => {
  const relation = {
    id: 'relation',
    sourcePostId: 'post',
    targetPostId: null,
    targetActorId: null,
    kind: 'repost',
    observedAt: null,
  };
  assert.equal(socialRelationshipSchema.safeParse(relation).success, false);
  assert.equal(
    socialRelationshipSchema.safeParse({ ...relation, targetActorId: 'actor' }).success,
    true,
  );
  assert.deepEqual(socialHandoffInputSchema.parse({ insightIds: ['insight:opening'] }), {
    noteIds: [],
    insightIds: ['insight:opening'],
  });
  assert.equal(socialHandoffInputSchema.safeParse({ workflowId: 'other' }).success, false);
});

test('research activity accepts curated public metadata and rejects private tool payloads or native paths', () => {
  const event = {
    agent: 'source_researcher',
    task: 'collect',
    phase: 'started',
    message: 'Searching public sources.',
    provider: 'x',
    search: 'coffee experiments',
  };
  assert.equal(socialResearchEventInputSchema.safeParse(event).success, true);
  for (const extra of [
    { reasoning: 'private model reasoning' },
    { authorization: 'Bearer secret' },
    { toolArguments: { apiKey: 'secret' } },
    { artifactPath: '/etc/passwd' },
  ])
    assert.equal(socialResearchEventInputSchema.safeParse({ ...event, ...extra }).success, false);
  assert.equal(socialResearchArtifactPathSchema.safeParse('/research/sources.json').success, true);
  assert.equal(socialResearchArtifactPathSchema.safeParse('../.env').success, false);
  assert.equal(
    socialResearchRunInputSchema.safeParse({
      topic: 'Coffee',
      harness: 'deepagents',
      apiKey: 'browser-secret',
    }).success,
    false,
  );
});
