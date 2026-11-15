import { ApiError } from './errors.js';
import {
  creatorVideoProfileIdSchema,
  creatorVideoProfileOptionSchema,
  type CreatorClip,
  type CreatorVideoProfileId,
  type CreatorVideoProfileOption,
} from '@yap/contracts/creator';
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

export type CreatorVideoProviderRegistry = ReadonlyMap<CreatorVideoProfileId, CreatorVideoProvider>;

/** Every profile keeps its own provider instance. Selection is never a retry policy. */
export function createConfiguredCreatorVideoProviders(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): CreatorVideoProviderRegistry {
  const providers = new Map<CreatorVideoProfileId, CreatorVideoProvider>();
  for (const model of ['gen4.5', 'gen4_turbo'] as const)
    for (const ratio of ['720:1280', '1280:720'] as const) {
      const provider = createCreatorVideoProvider(
        {
          provider: 'runway',
          apiKey: env.RUNWAYML_API_SECRET,
          model,
          ratio,
        },
        fetcher,
      );
      providers.set(provider.profile!.id!, provider);
    }
  const retired = createFalCreatorVideoProvider({ provider: 'fal', apiKey: env.FAL_KEY }, fetcher);
  providers.set('fal-seedance-v1.5-portrait', retired);
  return providers;
}

export function creatorVideoProfileOptions(
  registry: CreatorVideoProviderRegistry,
): CreatorVideoProfileOption[] {
  return [...registry.entries()].map(([id, provider]) => {
    const profile = provider.profile!;
    return creatorVideoProfileOptionSchema.parse({
      id,
      label: profile.label ?? id,
      provider: profile.provider,
      model: profile.model,
      ratio: profile.ratio,
      nativeWidth: profile.nativeWidth,
      nativeHeight: profile.nativeHeight,
      minSeconds: profile.minSeconds,
      maxSeconds: profile.maxSeconds,
      ...(profile.allowedSeconds ? { allowedSeconds: profile.allowedSeconds } : {}),
      requiresImage: profile.requiresImage ?? false,
      configured: provider.configured,
      ...(profile.retired ? { retired: true } : {}),
      ...(profile.unavailableReason
        ? { unavailableReason: profile.unavailableReason }
        : !provider.configured
          ? { unavailableReason: 'Configure RUNWAYML_API_SECRET to use this profile.' }
          : {}),
      rateCentsPerSecond: profile.rateCentsPerSecond,
    });
  });
}

/** Resolve the saved shot choice; omitted choices retain the plan's old provider. */
export function resolveCreatorVideoProvider(
  clip: Pick<CreatorClip, 'videoProfileId' | 'seconds' | 'assetId' | 'storyboardFrameId'>,
  fallback: CreatorVideoProvider,
  registry: CreatorVideoProviderRegistry,
  options: { requireConfigured?: boolean } = {},
): CreatorVideoProvider {
  const choice = clip.videoProfileId;
  const parsed = choice === undefined ? undefined : creatorVideoProfileIdSchema.safeParse(choice);
  if (parsed && !parsed.success)
    throw new ApiError(400, 'CREATOR_VIDEO_PROFILE', 'Choose a supported video profile.');
  const provider = parsed?.success ? registry.get(parsed.data) : fallback;
  if (!provider)
    throw new ApiError(400, 'CREATOR_VIDEO_PROFILE', 'This video profile is not available.');
  const profile = provider.profile;
  if (profile?.retired)
    throw new ApiError(
      503,
      'CREATOR_MODEL_RETIRED',
      profile.unavailableReason ?? 'This model is retired. Choose another supported profile.',
    );
  if (options.requireConfigured !== false && !provider.configured)
    throw new ApiError(
      503,
      'CREATOR_VIDEO_NOT_CONFIGURED',
      profile?.unavailableReason ?? 'Configure the selected video provider before production.',
    );
  if (
    profile &&
    (!Number.isInteger(clip.seconds) ||
      clip.seconds < profile.minSeconds ||
      clip.seconds > profile.maxSeconds ||
      (profile.allowedSeconds && !profile.allowedSeconds.includes(clip.seconds)))
  )
    throw new ApiError(
      400,
      'CREATOR_CLIP_DURATION',
      'Choose a shot duration supported by its selected profile.',
    );
  if (profile?.requiresImage && !clip.assetId && !clip.storyboardFrameId)
    throw new ApiError(
      400,
      'CREATOR_IMAGE_REQUIRED',
      'This profile needs an uploaded or approved storyboard image.',
    );
  return provider;
}
