import type { SocialResearchCapabilities, SocialResearchHarness } from '@yap/contracts/social';

export interface ResearchEngineSelection {
  value: SocialResearchHarness;
  baseline: SocialResearchHarness;
  explicit: boolean;
}

export const initialResearchEngine: ResearchEngineSelection = {
  value: 'pipeline',
  baseline: 'pipeline',
  explicit: false,
};

/** A server default initializes a pristine form; an explicit creator choice survives refreshes. */
export function applyResearchEngineDefault(
  selection: ResearchEngineSelection,
  capabilities: SocialResearchCapabilities,
): ResearchEngineSelection {
  if (selection.explicit) return selection;
  const value = capabilities.harnesses.some(
    (item) => item.id === capabilities.defaultHarness && item.configured,
  )
    ? capabilities.defaultHarness
    : 'pipeline';
  return { value, baseline: value, explicit: false };
}

export function chooseResearchEngine(
  selection: ResearchEngineSelection,
  value: SocialResearchHarness,
): ResearchEngineSelection {
  return { ...selection, value, explicit: true };
}
