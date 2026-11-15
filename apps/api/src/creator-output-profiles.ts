import {
  creatorOutputProfileIdSchema,
  type CreatorOutputProfileId,
  type CreatorPlan,
  type CreatorVideoRatio,
} from '@yap/contracts/creator';
import { ApiError } from './errors.js';

export interface CreatorOutputProfile {
  id: CreatorOutputProfileId;
  label: string;
  width: number;
  height: number;
  ratio: CreatorVideoRatio;
  /** True when delivery enlarges the supported 720p generation canvas. */
  resized: boolean;
}

export const CREATOR_OUTPUT_PROFILES: readonly CreatorOutputProfile[] = [
  {
    id: 'portrait-720',
    label: 'Portrait 720p · native size',
    width: 720,
    height: 1280,
    ratio: '720:1280',
    resized: false,
  },
  {
    id: 'landscape-720',
    label: 'Landscape 720p · native size',
    width: 1280,
    height: 720,
    ratio: '1280:720',
    resized: false,
  },
  {
    id: 'portrait-1080',
    label: 'Portrait 1080p · resized from 720p',
    width: 1080,
    height: 1920,
    ratio: '720:1280',
    resized: true,
  },
];

/** Historical omitted choices retain the existing portrait 1080p delivery. */
export function resolveOutputProfile(
  plan: Pick<CreatorPlan, 'outputProfileId'> | null | undefined,
): CreatorOutputProfile {
  const parsed = creatorOutputProfileIdSchema.safeParse(plan?.outputProfileId ?? 'portrait-1080');
  if (!parsed.success)
    throw new ApiError(400, 'CREATOR_OUTPUT_PROFILE', 'Choose a supported output size.');
  return { ...CREATOR_OUTPUT_PROFILES.find((profile) => profile.id === parsed.data)! };
}
