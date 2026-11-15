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
  const model =
    env.CREATOR_VIDEO_MODEL?.trim() || (provider === 'fal' ? 'seedance-v1.5-pro' : 'gen4.5');
  if (
    (provider === 'fal' && model !== 'seedance-v1.5-pro' && model !== 'minimax-h3-max') ||
    (provider === 'runway' && model !== 'gen4.5')
  )
    throw new ApiError(
      503,
      'CREATOR_CONFIGURATION',
      'Choose a video model supported by the selected provider.',
    );
  return {
    provider,
    model: model as CreatorVideoConfig['model'],
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
