import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  creatorInputSchema,
  creatorAnswerSchema,
  creatorResearchSchema,
  type CreatorInput,
  type CreatorAnswer,
  type CreatorResearch,
  type CreatorSource,
  type CreatorQuestion,
  type CreatorReference,
} from '@yap/contracts/creator';
import type { SocialDataset } from '@yap/contracts/social';
import type { SocialDeepAgentsContext, SocialDeepAgentsDependencies } from './social-deepagents.js';

export interface CreatorResearchConfig {
  firecrawlApiKey?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  deepAgentsModel?: string;
  deepAgentsApiKey?: string;
}
export interface CreatorResearchDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  deepAgentsRunner?: (
    context: SocialDeepAgentsContext,
    dependencies?: SocialDeepAgentsDependencies,
  ) => Promise<SocialDataset>;
}
export type CreatorResearchProgress = (message: string) => void;
type Coverage = NonNullable<CreatorResearch['coverage']>[number];
type Branch = Coverage['branch'];
type BranchResult = { sources: CreatorSource[]; coverage: Coverage; limitations: string[] };

const PROFESSIONAL_DOMAINS = ['arri.com', 'theasc.com', 'panavision.com', 'zeiss.com'];
const PLATFORM_DOMAINS = {
  x: ['x.com', 'twitter.com'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com'],
};
const SEARCH_URL = 'https://api.firecrawl.dev/v2/search';
const MAX_README_BYTES = 32 * 1024;
const identifier = (prefix: string, value: string) =>
  `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const clip = (value: unknown, max: number) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const domainMatches = (host: string, allowed: string[]) =>
  allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));

class ResearchFailure extends Error {}

/** Attribution validation only. Server requests below use fixed provider hosts. */
function publicUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !host.includes('.') ||
      isIP(host) ||
      host.includes(':') ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host) ||
      /(?:^|\.)\d{1,3}(?:[.-]\d{1,3}){3}(?:\.|$)/.test(host) ||
      [...url.searchParams.keys()].some((key) =>
        /token|api.?key|secret|password|signature/i.test(key),
      )
    )
      return null;
    url.hostname = host;
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return url;
  } catch {
    return null;
  }
}

function repositoryUrl(value: string): { owner: string; repo: string; url: string } | null {
  const url = publicUrl(value);
  if (!url || !['github.com', 'www.github.com'].includes(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0] ?? '';
  const repo = (parts[1] ?? '').replace(/\.git$/, '');
  if (
    !/^[a-z\d-]{1,39}$/i.test(owner) ||
    !/^[a-z\d_.-]{1,100}$/i.test(repo) ||
    ['.', '..'].includes(repo)
  )
    return null;
  if (parts.length > 2 && !['tree', 'blob'].includes(parts[2]!)) return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function safeSearchText(value: string, max = 250): string {
  return value
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b(?:gh[pousr]_[\w]+|sk-[\w-]+)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function contextFor(input: CreatorInput, answers: CreatorAnswer[]) {
  const answer = (id: string) =>
    answers.find((item) => item.questionId === id)?.answer.trim() ?? '';
  const location = input.location?.trim() || answer('location');
  const embeddedUrls = input.prompt.match(/https:\/\/[^\s<>"']+/g) ?? [];
  const urls = [
    ...new Set([...input.urls, ...embeddedUrls].map((value) => value.replace(/[),.;]+$/, ''))),
  ].slice(0, 5);
  const repositories = urls
    .map(repositoryUrl)
    .filter((item) => item !== null)
    .slice(0, 2);
  const software =
    repositories.length > 0 ||
    /\b(?:software|saas|app|website|github|developer|dashboard)\b/i.test(input.prompt);
  const place =
    Boolean(location) ||
    /\b(?:location|restaurant|cafe|café|shop|hotel|venue|neighbou?rhood|visit)\b/i.test(
      input.prompt,
    );
  const intent = software ? 'software' : place ? 'place' : 'product';
  const subject = safeSearchText(
    [answer('productName'), answer('productDescription') || input.prompt, location]
      .filter(Boolean)
      .join(' '),
  );
  const productFacts = [
    `Creator request: ${clip(input.prompt, 950)}`,
    ...(location
      ? [`Creator-provided location (not independently verified): ${clip(location, 850)}`]
      : []),
    ...answers
      .filter((item) => item.answer.trim())
      .map((item) => `Creator answer (${item.questionId}): ${clip(item.answer, 880)}`),
  ].slice(0, 20);
  const definitions: CreatorQuestion[] = [
    {
      id: 'productName',
      question: software
        ? 'What is the app or project called?'
        : place
          ? 'What is the business or place called?'
          : 'What is the product called?',
      why: 'Use your actual name rather than copying a reference brand.',
    },
    {
      id: 'productDescription',
      question: software
        ? 'Which real feature or user task should the demo show?'
        : place
          ? 'What do you offer, and what makes a visit worth showing?'
          : 'What is the product, and which visible details must remain accurate?',
      why: 'Your description supplies product facts. Repository and public-page claims still need your confirmation.',
    },
    {
      id: 'audience',
      question: 'Who should this video reach, and what do they already know?',
      why: 'The audience changes the opening, explanation, and pacing.',
    },
    {
      id: 'keyBenefits',
      question: software
        ? 'What can the product demonstrably do? List only features you can show.'
        : 'What should people like about it? Which benefits can you substantiate?',
      why: 'External examples do not establish claims about your product.',
    },
    {
      id: 'callToAction',
      question: software
        ? 'Should viewers try the app, visit the repository, or take another action?'
        : place
          ? 'Where should viewers go, and what should they do next?'
          : 'What should someone do after watching?',
      why: 'The ending needs your real destination or offer.',
    },
    {
      id: 'imageDirection',
      question:
        input.mode === 'media'
          ? 'Which supplied image details must stay recognizable, and what should we avoid changing?'
          : software
            ? 'Which real screens or interactions may we show, and what would a generated visual only illustrate?'
            : 'Describe the appearance and moments that may be generated, including anything that must not be invented.',
      why: 'Separate supplied evidence from illustrative generated footage.',
    },
    ...(place
      ? [
          {
            id: 'location',
            question:
              'Confirm the location, address or landmarks that may appear. What should stay private?',
            why: 'A public search cannot confirm your exact premises or permission to show an address.',
          },
        ]
      : []),
    {
      id: 'style',
      question:
        'What feeling and visual style should it have? Which retrieved examples do you like or dislike?',
      why: 'Selected references guide framing and rhythm, not product facts or permission to reuse footage.',
    },
  ];
  return {
    answer,
    location,
    urls,
    repositories,
    software,
    place,
    intent,
    subject,
    productFacts,
    questions: definitions.filter((question) => !answer(question.id)).slice(0, 8),
  };
}

function canceled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const stop = () =>
      reject(signal.reason ?? new DOMException('Research canceled.', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export function creatorResearchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CreatorResearchConfig {
  return {
    firecrawlApiKey: env.FIRECRAWL_API_KEY?.trim(),
    deepAgentsModel: env.DEEPAGENTS_MODEL?.trim(),
    deepAgentsApiKey: env.DEEPAGENTS_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim(),
  };
}

export function createCreatorResearch(
  config: CreatorResearchConfig = creatorResearchConfigFromEnv(),
  dependencies: CreatorResearchDependencies = {},
) {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  const timeout = config.timeoutMs ?? 15000;
  const maxBytes = config.maxResponseBytes ?? 512 * 1024;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 30000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 128 ||
    maxBytes > 1024 * 1024
  )
    throw new Error(
      'Use a research timeout of 1–30000 ms and response limit of 128–1048576 bytes.',
    );

  async function request(url: string, init: RequestInit, external?: AbortSignal) {
    canceled(external);
    const deadline = AbortSignal.timeout(timeout);
    const signal = external ? AbortSignal.any([external, deadline]) : deadline;
    try {
      const response = await abortable(
        fetcher(url, { ...init, signal, redirect: 'error' }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new ResearchFailure(
          response.status === 429 || response.status === 403
            ? 'The provider denied or rate-limited this request.'
            : 'The provider could not complete this request.',
        );
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        throw new ResearchFailure('The provider response exceeded the research byte limit.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ResearchFailure('The provider returned an empty response.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await abortable(reader.read(), signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes)
            throw new ResearchFailure('The provider response exceeded the research byte limit.');
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
      }
      try {
        return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        throw new ResearchFailure('The provider returned malformed research data.');
      }
    } catch (error) {
      canceled(external);
      if (error instanceof ResearchFailure) throw error;
      throw new ResearchFailure(
        deadline.aborted
          ? 'The provider research deadline was reached.'
          : 'The provider could not be reached safely.',
      );
    }
  }

  return async function analyze(
    inputValue: CreatorInput,
    answerValues: CreatorAnswer[],
    signal?: AbortSignal,
    onProgress?: CreatorResearchProgress,
  ): Promise<CreatorResearch> {
    const input = creatorInputSchema.parse(inputValue);
    if (answerValues.length > 20) throw new Error('Use at most twenty creator answers.');
    const answers = answerValues.map((value) => creatorAnswerSchema.parse(value));
    if (new Set(answers.map((answer) => answer.questionId)).size !== answers.length)
      throw new Error('Each creator question may have one current answer.');
    canceled(signal);
    const context = contextFor(input, answers);
    const collectedAt = now().toISOString();
    const emit = (message: string) => {
      if (signal?.aborted) return;
      try {
        onProgress?.(clip(message, 900));
      } catch {
        /* Telemetry cannot alter the research outcome. */
      }
    };
    const done = (
      branch: Branch,
      status: Coverage['status'],
      message: string,
      sources: CreatorSource[] = [],
      limitations: string[] = [],
    ): BranchResult => ({ sources, coverage: { branch, status, message }, limitations });

    async function search(
      branch: Branch,
      query: string,
      domains: string[],
      limit: number,
      kind: CreatorSource['kind'],
    ): Promise<BranchResult> {
      if (!config.firecrawlApiKey?.trim()) {
        emit(`${branch}: live public search unavailable; no Firecrawl server key is configured.`);
        return done(
          branch,
          'unavailable',
          'Live public search is unavailable because FIRECRAWL_API_KEY is not configured.',
          [],
          [
            `${branch}: no live search was performed. Configure FIRECRAWL_API_KEY on the server; no example data was substituted.`,
          ],
        );
      }
      emit(`${branch}: bounded public-source search started.`);
      try {
        const payload = await request(
          SEARCH_URL,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.firecrawlApiKey.trim()}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query,
              limit,
              sources: [{ type: 'web' }],
              includeDomains: domains,
              domainTools: false,
              timeout,
              ...(branch === 'cinematography' ? { scrapeOptions: { formats: ['markdown'] } } : {}),
            }),
          },
          signal,
        );
        if (payload.success === false)
          throw new ResearchFailure('The search provider did not complete the search.');
        const raw = record(payload.data).web;
        if (!Array.isArray(raw))
          throw new ResearchFailure('The search provider returned malformed research data.');
        const sources: CreatorSource[] = [];
        const seen = new Set<string>();
        for (const value of raw.slice(0, 20)) {
          if (sources.length >= limit) break;
          const item = record(value);
          const url = publicUrl(item.url);
          if (!url || (domains.length && !domainMatches(url.hostname, domains))) continue;
          if (branch === 'x' && !/^\/[^/]+\/status\/\d+\/?$/.test(url.pathname)) continue;
          if (branch === 'tiktok' && !/^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname)) continue;
          if (branch === 'instagram' && !/^\/(?:reel|p)\/[a-z\d_-]+\/?$/i.test(url.pathname))
            continue;
          if (branch !== 'context') url.search = '';
          if (seen.has(url.href)) continue;
          const excerpt = clip(
            branch === 'cinematography'
              ? item.markdown || item.description || item.title
              : item.description || item.title,
            1500,
          );
          if (!excerpt) continue;
          seen.add(url.href);
          sources.push({
            id: identifier(branch, url.href),
            url: url.href,
            title: clip(item.title, 200) || `${branch} source`,
            kind,
            excerpt,
            platform: ['x', 'tiktok', 'instagram'].includes(branch)
              ? (branch as 'x' | 'tiktok' | 'instagram')
              : 'web',
            provider: 'firecrawl',
            collectedAt,
            publishedAt: timestamp(
              item.publishedAt ?? item.published_at ?? record(item.metadata).publishedTime,
            ),
            contentKind:
              branch === 'cinematography' &&
              typeof item.markdown === 'string' &&
              item.markdown.trim()
                ? 'page'
                : 'search_result',
          });
        }
        emit(`${branch}: search completed with ${sources.length} validated sources.`);
        return done(
          branch,
          sources.length ? 'available' : 'empty',
          sources.length
            ? `${sources.length} attributed public sources retrieved.`
            : 'The search completed but returned no usable attributed sources.',
          sources,
          [
            branch === 'cinematography'
              ? 'Professional-source passages are retrieved text, not a verification of every technical claim or a substitute for reviewing the original guide.'
              : `${branch}: indexed descriptions are not video transcripts or visual inspection. Dates may be unknown; engagement, performance and completeness were not inferred.`,
          ],
        );
      } catch (error) {
        canceled(signal);
        const message =
          error instanceof ResearchFailure ? error.message : 'This research branch failed.';
        emit(`${branch}: research failed. ${message}`);
        return done(
          branch,
          'failed',
          message,
          [],
          [`${branch}: ${message} No synthetic replacement was added.`],
        );
      }
    }

    async function github(
      repository: NonNullable<ReturnType<typeof repositoryUrl>>,
    ): Promise<CreatorSource[]> {
      const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
      const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'Yap-public-creator-research',
      };
      const metadata = await request(endpoint, { headers }, signal);
      if (metadata.private !== false)
        throw new ResearchFailure(
          'Only repositories explicitly reported public by GitHub are read.',
        );
      const description = clip(metadata.description, 700);
      const sources: CreatorSource[] = [
        {
          id: identifier('github', repository.url),
          url: repository.url,
          title: clip(metadata.full_name, 200) || `${repository.owner}/${repository.repo}`,
          kind: 'github',
          platform: 'web',
          provider: 'github',
          collectedAt,
          publishedAt: null,
          contentKind: 'repository',
          excerpt: `Public repository metadata. Description supplied by its maintainer (unverified product claim): ${description || 'No description supplied.'} No repository code was downloaded or executed.`,
        },
      ];
      try {
        const readme = await request(`${endpoint}/readme`, { headers }, signal);
        if (
          readme.encoding !== 'base64' ||
          typeof readme.content !== 'string' ||
          Number(readme.size) > MAX_README_BYTES ||
          !/^[a-z\d+/=\s]*$/i.test(readme.content)
        )
          throw new ResearchFailure('The README is not a supported bounded base64 document.');
        const bytes = Buffer.from(readme.content.replace(/\s/g, ''), 'base64');
        if (bytes.length > MAX_README_BYTES)
          throw new ResearchFailure('The README exceeds the 32 KiB research limit.');
        const text = clip(bytes.toString('utf8'), 1300);
        if (text)
          sources.push({
            id: identifier('github-readme', repository.url),
            url: `${repository.url}#readme`,
            title: `${repository.owner}/${repository.repo} README`.slice(0, 200),
            kind: 'github',
            platform: 'web',
            provider: 'github',
            collectedAt,
            publishedAt: null,
            contentKind: 'repository',
            excerpt:
              `Untrusted maintainer README excerpt; confirm feature claims before using them: ${text}`.slice(
                0,
                1500,
              ),
          });
      } catch (error) {
        canceled(signal);
        sources[0]!.excerpt += ' README unavailable or outside the bounded supported format.';
      }
      return sources;
    }

    async function sourceContext(): Promise<BranchResult> {
      const sources: CreatorSource[] = [];
      const limitations: string[] = [];
      let failed = 0;
      if (context.urls.some((url) => !publicUrl(url)))
        limitations.push(
          'A supplied URL was rejected as unsafe or unsupported. Only public HTTPS references without credentials are considered.',
        );
      const repositories = [
        ...new Map(
          context.repositories.map((repository) => [repository.url.toLowerCase(), repository]),
        ).values(),
      ];
      emit('context: bounded creator context and public repository intake started.');
      const results = await Promise.allSettled(repositories.map(github));
      for (const result of results) {
        if (result.status === 'fulfilled') sources.push(...result.value);
        else {
          canceled(signal);
          failed++;
          limitations.push(
            'A GitHub repository could not be read as bounded public metadata/README. No clone, execution, redirect or private repository access was attempted.',
          );
        }
      }
      const otherUrls = context.urls
        .map(publicUrl)
        .filter((url) => url && !['github.com', 'www.github.com'].includes(url.hostname));
      if (otherUrls.length || context.location) {
        const domains = [...new Set(otherUrls.map((url) => url!.hostname))].slice(0, 3);
        const result = await search(
          'context',
          safeSearchText(
            `${context.subject} ${context.location || ''} official product location details`,
          ),
          domains,
          4,
          context.location ? 'location' : 'product',
        );
        sources.push(...result.sources);
        limitations.push(...result.limitations);
        if (result.coverage.status === 'failed' || result.coverage.status === 'unavailable')
          failed++;
      }
      limitations.push(
        'Public product, location and README descriptions are unverified source claims. Only creator-provided statements and explicit answers are product facts. No URL content or repository instructions are executed.',
      );
      const status = sources.length
        ? failed
          ? 'partial'
          : 'available'
        : failed
          ? 'unavailable'
          : 'empty';
      emit(`context: intake completed; ${sources.length} attributed sources, ${status}.`);
      return done(
        'context',
        status,
        sources.length
          ? 'Public context was retrieved for creator confirmation.'
          : 'No independently retrieved product/location context is available; creator questions remain usable.',
        sources,
        limitations,
      );
    }

    const scope = context.subject || 'product promotional film';
    const tasks = [
      search(
        'cinematography',
        `${scope} cinematography lighting framing camera movement product film (${PROFESSIONAL_DOMAINS.map((domain) => `site:${domain}`).join(' OR ')})`,
        PROFESSIONAL_DOMAINS,
        4,
        'cinematography',
      ),
      ...(['x', 'tiktok', 'instagram'] as const).map((platform) =>
        search(
          platform,
          `${scope} cinematic product commercial short film ${PLATFORM_DOMAINS[platform].map((domain) => `site:${domain}`).join(' OR ')}`,
          PLATFORM_DOMAINS[platform],
          3,
          'social',
        ),
      ),
      sourceContext(),
    ];
    const branches = await Promise.all(tasks);
    canceled(signal);
    const sources = [
      ...new Map(
        branches.flatMap((branch) => branch.sources).map((source) => [source.id, source]),
      ).values(),
    ].slice(0, 40);
    const limitations = branches.flatMap((branch) => branch.limitations);
    const professionals = sources.filter((source) => source.kind === 'cinematography');
    let cinematography = professionals.length
      ? `Professional source passages for creator review:\n${professionals.map((source) => `[${source.title}](${source.url}): ${source.excerpt}`).join('\n\n')}`.slice(
          0,
          6000,
        )
      : 'No live professional cinematography sources were retrieved. Camera and lighting choices still need creator review; no retrieved guidance was fabricated.';

    if (
      config.deepAgentsModel?.trim() &&
      config.deepAgentsApiKey?.trim() &&
      sources.some((source) => source.provider === 'firecrawl')
    ) {
      emit('Configured Deep Agents review of the retrieved evidence started.');
      try {
        const dataset: SocialDataset = {
          posts: sources.map((source) => ({
            id: source.id,
            platform:
              source.platform === 'x' || source.platform === 'instagram' ? source.platform : 'web',
            url: source.url,
            text: source.excerpt,
            actorId: null,
            publishedAt: source.publishedAt ?? null,
            collectedAt: source.collectedAt ?? collectedAt,
            provider: source.provider === 'github' ? 'import' : 'firecrawl',
            contentKind: source.contentKind === 'page' ? 'page' : 'search_result',
            metrics: { likes: null, replies: null, shares: null, views: null },
          })),
          actors: [],
          relationships: [],
          warnings: [
            'This immutable evidence batch includes professional guides and indexed TikTok pages as web sources. No visual video analysis, engagement, causality or observed account network is implied.',
          ],
        };
        const runner =
          dependencies.deepAgentsRunner ??
          (await import('./social-deepagents.js')).runSocialDeepAgents;
        const artifacts = new Map<string, string>();
        await runner(
          {
            input: {
              topic: clip(scope, 300),
              audience: clip(context.answer('audience'), 500),
              platforms: ['x', 'instagram', 'web'],
              mode: 'live',
              days: 7,
              limit: Math.max(1, Math.min(40, sources.length)),
              harness: 'deepagents',
            },
            signal: signal ?? new AbortController().signal,
            emit: (event) => emit(`Deep Agents: ${event.message}`),
            writeArtifact: (path, content) => {
              if (Buffer.byteLength(content) > 32 * 1024)
                throw new ResearchFailure('The agent research artifact exceeded its byte budget.');
              artifacts.set(path, content);
            },
            collect: async () => dataset,
          },
          {
            fetch: fetcher,
            config: {
              model: config.deepAgentsModel.trim(),
              apiKey: config.deepAgentsApiKey.trim(),
              timeoutMs: 45000,
              maxModelCalls: 24,
            },
          },
        );
        canceled(signal);
        if (
          ['scope.json', 'sources.json', 'network.json', 'insights.json', 'brief.md'].some(
            (name) => !artifacts.has(`/research/${name}`),
          )
        )
          throw new ResearchFailure(
            'The agent review did not retain its complete evidence artifacts.',
          );
        limitations.push(
          'A configured LangChain Deep Agents harness planned and reviewed this immutable retrieved batch through its specialists. Its TikTok entries were treated as web evidence; it performed no additional source searches or visual video inspection.',
        );
        cinematography =
          `${cinematography.slice(0, 3900)}\n\nConfigured Deep Agents evidence review completed. Proposed creative framing, not verified product facts:\n${clip(artifacts.get('/research/brief.md'), 1800)}\nOriginal citations and creator review remain authoritative.`.slice(
            0,
            6000,
          );
        emit('Configured Deep Agents evidence review completed.');
      } catch {
        canceled(signal);
        limitations.push(
          'The optional configured Deep Agents review failed or reached its call/deadline budget. Retrieved sources are retained as public search results; no agent success was claimed.',
        );
        emit(
          'Configured Deep Agents evidence review did not complete; attributed search results retained.',
        );
      }
    } else
      limitations.push(
        'Collection used bounded public search and/or public GitHub metadata. No Deep Agents execution is claimed without configured model credentials and retrieved evidence.',
      );

    const references: CreatorReference[] = sources
      .filter((source) => source.kind === 'social')
      .map((source) => ({
        id: identifier('reference', source.id),
        sourceIds: [source.id],
        title: source.title,
        hook: `Indexed description, not a verified opening transcript: ${clip(source.excerpt, 800)}`,
        visualDirection:
          'Review the original public example for framing, reveal order and pacing before selecting it. A search description does not establish the actual shots. Use your own product and footage; do not copy the source script or claim permission to reuse it.',
        rationale: `Attributed ${source.platform} discovery matched the creator topic. Engagement, quality ranking and visual similarity were not inferred. Like it only if the original fits your direction.`,
      }));
    for (const source of professionals.slice(0, 3))
      references.push({
        id: identifier('reference', source.id),
        sourceIds: [source.id],
        title: source.title,
        hook: 'Professional cinematography guidance to review alongside the original source.',
        visualDirection: source.excerpt.slice(0, 1900),
        rationale:
          'An attributed professional guide can inform camera and lighting choices; its advice is separate from product claims and still needs creator judgment.',
      });
    const available = branches
      .filter((branch) => branch.sources.length > 0)
      .map((branch) => branch.coverage.branch);
    return creatorResearchSchema.parse({
      summary: `Creator-described ${context.intent} promo. ${sources.length} attributed sources retrieved${available.length ? ` across ${available.join(', ')}` : '; live research is unavailable or returned no usable evidence'}. Your explicit answers shape the brief; external examples remain separate creative context. No content was approved and no video generation was started.`,
      productFacts: context.productFacts,
      cinematography,
      sources,
      references: references.slice(0, 12),
      questions: context.questions,
      limitations: [...new Set(limitations)].slice(0, 20),
      coverage: branches.map((branch) => branch.coverage),
    });
  };
}

export async function analyzeCreator(
  input: CreatorInput,
  answers: CreatorAnswer[],
  signal?: AbortSignal,
  onProgress?: CreatorResearchProgress,
): Promise<CreatorResearch> {
  return createCreatorResearch()(input, answers, signal, onProgress);
}
