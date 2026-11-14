import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { CreatorBudgetLedger, CreatorReservation } from './creator-budget.js';
import type { CreatorAnalyzer } from './creator-jobs.js';
import { readBounded } from './creator-video-provider.js';
import { ApiError } from './errors.js';

export const BUDGET_OPENAI_MODEL = 'gpt-6-luna';
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8000;
// Luna's full 1.05M context, long-context/cache-write premiums and capped output
// fit below this hold at Standard pricing. Never enable paid built-in tools here.
const OPENAI_RESERVATION_CENTS = 50;
interface CoveredRequest {
  submitted: number;
  beforeSubmit?: () => Promise<void>;
}

/** One ledger also covers legacy OpenAI drafting and public search using the same keys. */
export function createCreatorPaidRequests(delegate: typeof globalThis.fetch = globalThis.fetch) {
  let ledger: CreatorBudgetLedger | undefined;
  const covered = new AsyncLocalStorage<CoveredRequest>();
  const requireLedger = () => {
    if (!ledger)
      throw new ApiError(
        503,
        'CREATOR_BUDGET_NOT_READY',
        'Spending controls are not ready. No paid call was started.',
      );
    return ledger;
  };
  async function settle(reservation: CreatorReservation, cents: number): Promise<void> {
    // A failed refund leaves the original conservative hold in place.
    await requireLedger()
      .settle(reservation.id, cents)
      .catch(() => undefined);
  }
  async function accountKnownUsage(
    response: Response,
    reservation: CreatorReservation,
    signal: AbortSignal,
  ): Promise<void> {
    if ([400, 401, 403, 404, 429].includes(response.status)) {
      await settle(reservation, 0);
      return;
    }
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    try {
      const bytes = await readBounded(response.clone(), 512 * 1024, signal);
      const parsed = JSON.parse(bytes.toString('utf8')) as { usage?: Record<string, unknown> };
      const input = parsed.usage?.input_tokens ?? parsed.usage?.prompt_tokens;
      const output = parsed.usage?.output_tokens ?? parsed.usage?.completion_tokens;
      if (
        typeof input !== 'number' ||
        typeof output !== 'number' ||
        !Number.isSafeInteger(input) ||
        !Number.isSafeInteger(output) ||
        input < 0 ||
        output < 0
      )
        return;
      // Standard public rates: $0.10/M input and $0.50/M output. Ignore cache discounts;
      // round upward to cents. This is conservative usage accounting, not an invoice.
      const longContext = input > 272_000;
      // Include the cache-write premium even when no cache was written.
      const cents = Math.ceil(
        (input * 12.5 * (longContext ? 2 : 1) + output * 50 * (longContext ? 1.5 : 1)) / 1_000_000,
      );
      if (cents <= reservation.amountCents) await settle(reservation, cents);
    } catch {
      /* Unknown outcomes keep the full reservation. */
    }
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (['api.x.ai', 'api.x.com', 'api.twitter.com'].includes(url.hostname))
      throw new ApiError(
        503,
        'CREATOR_BUDGET_PROVIDER',
        'Direct X and Grok calls are outside this budget profile. Use indexed public discovery.',
      );
    const openai = url.hostname === 'api.openai.com' && request.method === 'POST';
    const firecrawl = url.hostname === 'api.firecrawl.dev' && request.method === 'POST';
    if (!openai && !firecrawl) return delegate(input, init);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      throw new ApiError(
        503,
        'CREATOR_BUDGET_PROVIDER',
        'Use the official HTTPS provider endpoint.',
      );
    const bytes = await readBounded(
      new Response(request.clone().body),
      MAX_BODY_BYTES,
      request.signal,
    );
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      throw new ApiError(
        400,
        'CREATOR_BUDGET_BODY',
        'The paid request could not be safely estimated.',
      );
    }
    let amountCents: number;
    if (openai) {
      if (
        !['/v1/responses', '/v1/chat/completions'].includes(url.pathname) ||
        body.model !== BUDGET_OPENAI_MODEL
      )
        throw new ApiError(
          503,
          'CREATOR_BUDGET_MODEL',
          'The budget profile uses gpt-6-luna for OpenAI requests. Set OPENAI_MODEL and DEEPAGENTS_MODEL accordingly.',
        );
      const completion = url.pathname.endsWith('/chat/completions');
      const key = completion ? 'max_completion_tokens' : 'max_output_tokens';
      const value = body[key] ?? body.max_tokens ?? 2048;
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_OUTPUT_TOKENS
      )
        throw new ApiError(
          400,
          'CREATOR_BUDGET_TOKENS',
          'Use at most 8,000 output tokens per paid model request.',
        );
      body[key] = value;
      if (
        (body.tools !== undefined &&
          (!Array.isArray(body.tools) ||
            body.tools.some(
              (tool: unknown) =>
                !tool || typeof tool !== 'object' || !('type' in tool) || tool.type !== 'function',
            ))) ||
        (body.n !== undefined && body.n !== 1)
      )
        throw new ApiError(
          503,
          'CREATOR_BUDGET_TOOLS',
          'Only local function tools and one completion are priced in this budget profile.',
        );
      // Standard service has a known ceiling; project defaults cannot opt this call into Fast.
      body.service_tier = 'default';
      if (completion) {
        delete body.max_tokens;
        // This model supports Chat Completions function calls with reasoning disabled.
        body.reasoning_effort = 'none';
      }
      amountCents = OPENAI_RESERVATION_CENTS;
    } else {
      if (!['/v2/search', '/v2/scrape'].includes(url.pathname))
        throw new ApiError(
          503,
          'CREATOR_BUDGET_PROVIDER',
          'This Firecrawl operation has no approved budget estimate.',
        );
      const count = url.pathname === '/v2/search' ? (body.limit ?? 10) : 1;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100)
        throw new ApiError(400, 'CREATOR_BUDGET_SEARCH', 'Use between one and 100 search results.');
      amountCents = Math.max(10, Math.ceil(count / 10) * 10);
    }
    const parent = covered.getStore();
    if (parent && (!openai || parent.submitted >= 1))
      throw new ApiError(503, 'CREATOR_BUDGET_AUDIT', 'A clip quote covers one visual audit.');
    const activeLedger = requireLedger();
    const reservation = parent
      ? undefined
      : await activeLedger.reserve({
          idempotencyKey: `request:${randomUUID()}`,
          category: openai ? 'drafting' : 'research',
          sourceId: openai ? 'openai:gpt-6-luna' : `firecrawl:${url.pathname}`,
          amountCents,
        });
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    if (parent) parent.submitted++;
    try {
      await parent?.beforeSubmit?.();
      request.signal.throwIfAborted();
    } catch (error) {
      if (reservation) await settle(reservation, 0);
      throw error;
    }
    // No retry. A disconnect, timeout or uncertain response keeps its reserved ceiling.
    const response = await delegate(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
      redirect: 'error',
    });
    if (reservation && openai) await accountKnownUsage(response, reservation, request.signal);
    if (reservation && firecrawl && response.status === 401) await settle(reservation, 0);
    return response;
  };
  return {
    fetch,
    attach(value: CreatorBudgetLedger) {
      ledger = value;
    },
    async prepaid<T>(operation: () => Promise<T>, beforeSubmit?: () => Promise<void>): Promise<T> {
      if (covered.getStore()) return operation();
      return covered.run({ submitted: 0, beforeSubmit }, operation);
    },
    research(analyze: CreatorAnalyzer, live: boolean): CreatorAnalyzer {
      return async (...args) => {
        args[2]?.throwIfAborted();
        if (live) requireLedger();
        // Each SDK/tool dispatch reserves atomically. A batch cannot hide arbitrary
        // calls under a fixed prepaid allowance, and known token usage releases slack.
        return analyze(...args);
      };
    },
  };
}
