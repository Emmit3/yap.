import assert from 'node:assert/strict';
import test from 'node:test';
import { socialDatasetSchema, socialResearchInputSchema } from '@yap/contracts/social';
import { createSocialProviders } from '../src/social-providers.js';
import { ApiError } from '../src/errors.js';

const fixed = new Date('2026-11-13T18:00:00.000Z');
const input = (changes = {}) =>
  socialResearchInputSchema.parse({ topic: 'beginner coffee', mode: 'live', ...changes });
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('demonstration is explicit, bounded, platform scoped, and makes no external requests', async () => {
  let calls = 0;
  const provider = createSocialProviders(
    {},
    {
      now: () => fixed,
      fetch: async () => {
        calls++;
        throw new Error('Unexpected network');
      },
    },
  );
  const data = socialDatasetSchema.parse(
    await provider.collect(input({ mode: 'demo', platforms: ['instagram'], limit: 8 })),
  );
  assert.equal(calls, 0);
  assert.equal(data.posts.length, 8);
  assert.ok(data.posts.every((post) => post.provider === 'demo' && post.platform === 'instagram'));
  assert.ok(data.warnings.some((warning) => warning.includes('synthetic')));
  assert.ok(data.relationships.length > 0);
  await assert.rejects(
    provider.collect(input()),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_NOT_CONFIGURED',
  );
});

test('Firecrawl scopes each selected platform, shares the record budget, and keeps unknown metrics null', async () => {
  const calls: Array<{ query: string; limit: number }> = [];
  const provider = createSocialProviders(
    { firecrawlApiKey: 'server-secret' },
    {
      now: () => fixed,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer server-secret');
        const url = body.query.includes('site:x.com')
          ? 'https://x.com/publiccreator/status/123'
          : body.query.includes('site:instagram.com')
            ? 'https://www.instagram.com/reel/Abc123/'
            : 'https://example.org/coffee';
        return json({
          success: true,
          data: {
            web: [
              {
                url,
                title: 'A practical coffee demonstration',
                description: 'Three coffee mistakes and a small test',
                markdown: 'Public page text',
              },
            ],
          },
        });
      },
    },
  );
  const data = await provider.collect(input({ limit: 7 }));
  assert.equal(calls.length, 3);
  assert.equal(
    calls.reduce((sum, call) => sum + call.limit, 0),
    7,
  );
  assert.equal(data.posts.length, 3);
  assert.equal(
    data.posts.find((post) => post.platform === 'instagram')?.contentKind,
    'search_result',
  );
  assert.equal(data.posts.find((post) => post.platform === 'instagram')?.publishedAt, null);
  assert.ok(data.posts.every((post) => post.metrics.likes === null && post.metrics.views === null));
  assert.equal(data.relationships.length, 0);
  assert.ok(data.warnings.some((warning) => warning.includes('Instagram')));
});

test('X collection retains observed metrics, author identity, references, and the seven day limit', async () => {
  let called: URL | undefined;
  const provider = createSocialProviders(
    { xBearerToken: 'key' },
    {
      now: () => fixed,
      fetch: async (url) => {
        called = new URL(String(url));
        return json({
          data: [
            {
              id: '123',
              author_id: '7',
              text: 'Try this small coffee test',
              created_at: '2026-11-12T12:00:00Z',
              public_metrics: { like_count: 14, reply_count: 2, retweet_count: 3 },
              referenced_tweets: [{ id: '122', type: 'quoted' }],
              entities: { mentions: [{ id: '8', username: 'fieldnotes' }] },
            },
          ],
          includes: { users: [{ id: '7', username: 'publiccreator', name: 'Public creator' }] },
          meta: { next_token: 'remaining' },
        });
      },
    },
  );
  const data = await provider.collect(input({ platforms: ['x'], days: 30, limit: 10 }));
  assert.equal(called?.hostname, 'api.x.com');
  assert.equal(called?.searchParams.get('max_results'), '10');
  assert.equal(called?.searchParams.get('start_time'), '2026-11-06T18:01:00.000Z');
  assert.equal(data.posts[0]?.metrics.likes, 14);
  assert.equal(data.posts[0]?.metrics.views, null);
  assert.equal(data.posts[0]?.url, 'https://x.com/publiccreator/status/123');
  assert.equal(data.relationships[0]?.kind, 'quote');
  assert.equal(data.relationships[1]?.kind, 'mention');
  assert.ok(data.warnings.some((warning) => warning.includes('seven days')));
  assert.ok(data.warnings.some((warning) => warning.includes('One page')));
});

test('cross-provider duplicates prefer actual post text over indexed snippets', async () => {
  const provider = createSocialProviders(
    { xBearerToken: 'x-key', firecrawlApiKey: 'fire-key' },
    {
      fetch: async (url) =>
        String(url).includes('api.x.com')
          ? json({
              data: [
                {
                  id: '123',
                  author_id: '7',
                  text: 'Actual public post',
                  public_metrics: { like_count: 9 },
                },
              ],
              includes: { users: [{ id: '7', username: 'creator' }] },
            })
          : json({
              success: true,
              data: {
                web: [
                  {
                    url: 'https://twitter.com/creator/status/123?tracking=1',
                    description: 'Search snippet',
                  },
                ],
              },
            }),
    },
  );
  const data = await provider.collect(input({ platforms: ['x'], limit: 4 }));
  assert.equal(data.posts.length, 1);
  assert.equal(data.posts[0]?.provider, 'x');
  assert.equal(data.posts[0]?.text, 'Actual public post');
  assert.equal(data.posts[0]?.metrics.likes, 9);
});

test('Grok citations are discovery records and generated prose never becomes post content', async () => {
  const provider = createSocialProviders(
    { xaiApiKey: 'key', xaiModel: 'configured-model' },
    {
      now: () => fixed,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'configured-model');
        assert.equal(body.tools[0].type, 'x_search');
        return json({
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'An invented account got 50 million likes.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://x.com/creator/status/123',
                      title: 'Coffee example',
                    },
                    {
                      type: 'url_citation',
                      url: 'https://example.org/unrelated',
                      title: 'Other page',
                    },
                  ],
                },
              ],
            },
          ],
        });
      },
    },
  );
  const data = await provider.collect(input({ platforms: ['x'] }));
  assert.equal(data.posts.length, 1);
  assert.equal(data.posts[0]?.text, 'Coffee example');
  assert.equal(data.posts[0]?.contentKind, 'search_result');
  assert.equal(data.posts[0]?.metrics.likes, null);
  assert.equal(data.relationships.length, 0);
});

test('partial provider failure stays explicit and never falls back to synthetic results', async () => {
  const provider = createSocialProviders(
    { xBearerToken: 'secret-x', firecrawlApiKey: 'secret-f' },
    {
      fetch: async (url) =>
        String(url).includes('api.x.com')
          ? new Response('private error with secret-x', { status: 429 })
          : json({
              success: true,
              data: { web: [{ url: 'https://x.com/a/status/123', description: 'Indexed result' }] },
            }),
    },
  );
  const data = await provider.collect(input({ platforms: ['x'] }));
  assert.equal(data.posts[0]?.provider, 'firecrawl');
  assert.ok(data.warnings.some((warning) => warning.includes('usage limit')));
  assert.ok(!JSON.stringify(data).includes('secret-x'));
});

test('provider timeout and response size budgets fail without returning untrusted payloads', async () => {
  const timeout = createSocialProviders(
    { firecrawlApiKey: 'key', timeoutMs: 5 },
    { fetch: async () => new Promise<Response>(() => undefined) },
  );
  const keepAlive = setTimeout(() => undefined, 100);
  try {
    await assert.rejects(
      timeout.collect(input({ platforms: ['web'] })),
      (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_SEARCH_FAILED',
    );
  } finally {
    clearTimeout(keepAlive);
  }
  const large = createSocialProviders(
    { firecrawlApiKey: 'key' },
    {
      fetch: async () =>
        new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    },
  );
  await assert.rejects(
    large.collect(input({ platforms: ['web'] })),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_SEARCH_FAILED',
  );
});
