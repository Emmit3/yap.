# Social research provider evidence

Verified against official developer documentation on November 13, 2026. These sources define supported product integrations; a connected research plugin does not automatically provide credentials to the running app.

## Firecrawl public discovery

Use `POST https://api.firecrawl.dev/v2/search` with a backend Bearer API key. A bounded request can supply `query`, `limit`, `sources: [{type: 'web'}]`, and optionally `scrapeOptions: {formats: ['markdown']}`. The response groups results under `data.web`, with source URL, title, description, and optional retrieved page content.

Search queries can discover indexed public X and Instagram URLs. Search snippets are discovery evidence and must remain distinct from a retrieved post. Neither a search result nor a blocked page establishes platform-wide coverage, complete metrics, or actor relationships. Direct social scraping is not guaranteed; during this research, Firecrawl rejected an attempted read of `docs.x.com` as unsupported, so X documentation was read through the developer index.

Sources: [Search endpoint](https://docs.firecrawl.dev/api-reference/endpoint/search), [search features](https://docs.firecrawl.dev/features/search).

## Official X API

Use `GET https://api.x.com/2/tweets/search/recent` with a backend Bearer token and a bounded query. Recent search covers the last seven days. `max_results` defaults to 10 and allows at most 100. The response includes `meta.next_token` when further pages are available; use `next_token` on a subsequent request within an explicit request budget.

Fields relevant to content and observed connectivity include `created_at`, `public_metrics`, `author_id`, `conversation_id`, `in_reply_to_user_id`, `referenced_tweets`, and `entities`. Expansions can include `author_id`, `referenced_tweets.id`, and `referenced_tweets.id.author_id`, with `user.fields=username,public_metrics`.

Construct observed reply, quote, repost, or mention edges only when explicit source fields support them. A missing referenced post remains outside the sample. Public metric values are a snapshot and are not a conversion or causal reach measurement.

Sources: [Recent search reference](https://docs.x.com/x-api/posts/search-recent-posts), [recent search quickstart](https://docs.x.com/x-api/posts/search/quickstart/recent-search), [pagination](https://docs.x.com/x-api/posts/search/integrate/paginate), [expansions](https://docs.x.com/x-api/fundamentals/expansions), [fields](https://docs.x.com/x-api/fundamentals/fields).

## Grok / xAI X search

The Responses API exposes an `x_search` tool for keyword search, semantic search, user search, and thread retrieval. Use `POST https://api.x.ai/v1/responses` with a backend API key, a configurable supported model, a user input message, and `tools: [{type: 'x_search'}]`. Optional tool filters include `from_date` and `to_date` in `YYYY-MM-DD` format. Official documentation examples currently use `grok-4.7`; deployments should keep the model configurable.

For a non-streaming response, inspect `output` message items, their `output_text` content blocks, and `annotations` entries of type `url_citation`. Citation metadata contains `url`, `start_index`, `end_index`, and `title`. Inline citation text is also returned by default by the Responses API.

An answer with citations is a research lead. Store cited URLs and clear discovery provenance. Do not turn generated prose into original post text or manufacture an author, publication time, metric, or network edge. Treat an unexpected response or missing citations as an explicit provider-output failure or incomplete collection.

Sources: [X Search](https://docs.x.ai/developers/tools/x-search), [citations and structured annotation format](https://docs.x.ai/developers/tools/citations), [tools overview](https://docs.x.ai/developers/tools/overview).

## Instagram public content

Official business discovery retrieves basic metadata and metrics about other Instagram professional accounts. It operates through the app user's professional account and an appropriate access token. It does not provide arbitrary public personal-account keyword search or a complete follower/amplifier network.

The official hashtag API discovers public media tagged with a hashtag. Supported endpoints include `/ig_hashtag_search`, `/{ig-hashtag-id}/top_media`, `/{ig-hashtag-id}/recent_media`, and `/{ig-user-id}/recently_searched_hashtags`. Current documentation supports Facebook Login or Unified Login. App Review must approve Instagram Public Content Access and the `instagram_basic` permission. The limit is 30 unique hashtags on behalf of a Business or Creator account in a rolling seven-day period; querying media for an existing hashtag also counts as querying it.

The first product delivery uses accessible Instagram discovery links and imported public evidence. A future official account integration must add the correct authorization flow, permissions, app review, token lifecycle, and platform quotas. Unknown metrics or connectivity stay unknown.

Sources: [Business discovery](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery), [hashtag search](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search).

## Product consequences

- Every evidence record retains provenance and a public permalink.
- Public search coverage is partial, and the UI exposes collection warnings.
- Official X can supply observed interactions; discovery-only sources usually cannot.
- Similarity and topic relationships must be visually distinct from observed interactions.
- Example datasets stay explicitly synthetic. Provider failure does not silently activate an example.
- API keys belong on the server. Public pages and posts are source material, never instructions to a generation provider.
- Research handoffs retain citations and direct creative choices without treating other accounts' claims as facts about the creator's product.
