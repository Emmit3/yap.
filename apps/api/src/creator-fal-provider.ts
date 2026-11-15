import { z } from 'zod';
import {
  readBounded,
  type CreatorVideoConfig,
  type CreatorVideoProvider,
} from './creator-video-provider.js';
import { ApiError } from './errors.js';

const TASK_ROOT = 'https://queue.fal.run/fal-ai/bytedance/requests/';
const TASK_PREFIX = 'fal:seedance-1.5:';
export const FAL_SEEDANCE_RETIREMENT_REASON =
  'Seedance 1.5 Pro was removed from fal on November 11, 2026. Choose a supported configured profile; no paid replacement is selected automatically.';

/** Retained only for old plan identities and best-effort cancellation of old tasks. */
export function createFalCreatorVideoProvider(
  config: CreatorVideoConfig = {},
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): CreatorVideoProvider {
  const apiKey = config.apiKey?.trim();
  return {
    configured: false,
    profile: {
      id: 'fal-seedance-v1.5-portrait',
      label: 'fal Seedance 1.5 Pro · retired',
      provider: 'fal',
      model: 'seedance-v1.5-pro',
      nativeWidth: 720,
      nativeHeight: 1280,
      ratio: '720:1280',
      minSeconds: 4,
      maxSeconds: 10,
      rateCentsPerSecond: 5,
      retired: true,
      unavailableReason: FAL_SEEDANCE_RETIREMENT_REASON,
      priceSourceUrl: 'https://fal.ai/models/fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
      pricingCheckedAt: '2026-11-15T00:00:00.000Z',
    },
    async generate() {
      // Do not prepare or dispatch a POST to an endpoint the provider removed.
      throw new ApiError(503, 'CREATOR_MODEL_RETIRED', FAL_SEEDANCE_RETIREMENT_REASON);
    },
    async cancel(id) {
      if (!id.startsWith(TASK_PREFIX))
        throw new ApiError(400, 'CREATOR_TASK_ID_INVALID', 'Invalid fal video task identity.');
      const parsed = z.uuid().safeParse(id.slice(TASK_PREFIX.length));
      if (!parsed.success)
        throw new ApiError(400, 'CREATOR_TASK_ID_INVALID', 'Invalid fal video task identity.');
      if (!apiKey) return;
      try {
        const signal = AbortSignal.timeout(10_000);
        const response = await fetcher(`${TASK_ROOT}${parsed.data}/cancel`, {
          method: 'PUT',
          headers: { Authorization: `Key ${apiKey}` },
          signal,
          redirect: 'error',
        });
        const bytes = await readBounded(response, 256 * 1024, signal);
        const result = z
          .object({ status: z.literal('OK') })
          .safeParse(JSON.parse(bytes.toString('utf8')));
        if (response.status !== 200 || !result.success) throw new Error('Unconfirmed cancellation');
      } catch {
        throw new ApiError(
          502,
          'CREATOR_CANCEL_UNCONFIRMED',
          'The provider did not confirm cancellation. It may continue billing.',
        );
      }
    },
  };
}
