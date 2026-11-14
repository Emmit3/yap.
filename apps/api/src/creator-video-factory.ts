import { ApiError } from './errors.js';
import { createFalCreatorVideoProvider } from './creator-fal-provider.js';
import {
  createCreatorVideoProvider,
  type CreatorVideoConfig,
  type CreatorVideoProvider,
} from './creator-video-provider.js';

export function creatorVideoConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CreatorVideoConfig {
  const provider = env.CREATOR_VIDEO_PROVIDER?.trim() || 'fal';
  if (provider !== 'fal' && provider !== 'runway')
    throw new ApiError(
      503,
      'CREATOR_CONFIGURATION',
      'Use fal or runway for CREATOR_VIDEO_PROVIDER.',
    );
  return {
    provider,
    apiKey: provider === 'fal' ? env.FAL_KEY : env.RUNWAYML_API_SECRET,
  };
}

/** Provider selection is explicit; failures never trigger another paid provider. */
export function createConfiguredCreatorVideoProvider(
  config: CreatorVideoConfig = creatorVideoConfigFromEnv(),
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): CreatorVideoProvider {
  const provider = config.provider ?? creatorVideoConfigFromEnv().provider;
  return provider === 'fal'
    ? createFalCreatorVideoProvider(config, fetcher)
    : createCreatorVideoProvider(config, fetcher);
}
