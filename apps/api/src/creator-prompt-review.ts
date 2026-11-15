import {
  creatorPromptReviewSchema,
  type CreatorPlan,
  type CreatorPromptReview,
} from '@yap/contracts/creator';
import { creatorVideoPrompt } from './creator-video-provider.js';

const affirmativeClauses = (text: string) =>
  text
    .split(/[.!?;,\n]+/)
    .filter((clause) => !/\b(no|without|avoid|never|do not|don't)\b/i.test(clause))
    .join('. ');

/** Free, deterministic screening of explicit conflicts; not a quality or truth certificate. */
export function reviewCreatorPrompts(plan: CreatorPlan): CreatorPromptReview {
  const clips = plan.clips.map((clip) => {
    const compiledPrompt = creatorVideoPrompt(clip);
    const issues: CreatorPromptReview['clips'][number]['issues'] = [];
    const add = (
      code: string,
      message: string,
      suggestion: string,
      severity: 'warning' | 'blocking' = 'warning',
    ) => issues.push({ code, severity, message, suggestion });
    // Only flag affirmative clauses. In particular, "no captions" is not a request for captions.
    const affirmative = affirmativeClauses([clip.prompt, clip.camera, clip.lighting].join('\n'));
    if (compiledPrompt.length > 1000)
      add(
        'prompt_length',
        'The complete provider prompt exceeds 1,000 characters.',
        'Shorten the visual, camera or lighting direction. Keep the subject and essential motion.',
        'blocking',
      );
    if (
      /\b(voiceover|voice over|dialogue|lip sync|soundtrack|music|speaks|says|singing)\b/i.test(
        affirmative,
      )
    )
      add(
        'silent_output',
        'This direction requests sound or speech, but this production path is silent.',
        'Describe the visible action here. Keep spoken words and sound instructions out of the shot prompt.',
      );
    if (
      /\b(add|include|display|write|render|show)\s+(?:(?:a|the|some|large|readable|on.screen)\s+)*(?:text|caption|captions|lettering|logo|logos|title|titles)\b/i.test(
        affirmative,
      )
    )
      add(
        'added_text',
        'This direction requests lettering that conflicts with the provider prompt.',
        'Keep added lettering out of generated footage. Preserve any existing product markings in the source image.',
      );
    if (
      /\b(montage|multiple scenes|jump cut|then cut|cut to|switch to another|transition to another)\b/i.test(
        affirmative,
      )
    )
      add(
        'continuous_shot',
        'This direction may ask for several shots inside one continuous clip.',
        'Choose one subject action and one camera movement. Put the next scene in a separate shot.',
      );
    const camera = affirmativeClauses(clip.camera).toLowerCase();
    if (
      /\b(static camera|locked.off camera|camera stays still|stationary camera)\b/.test(camera) &&
      /\b(dolly|tracking|orbit|pan|push in|pull back|zoom)\b/.test(camera)
    )
      add(
        'camera_conflict',
        'The camera direction requests both a stationary camera and camera movement.',
        'Keep either a locked camera or one named move, then specify its direction and speed.',
      );
    if (!clip.assetId && !clip.keyframeId)
      add(
        'no_visual_anchor',
        'This shot has no selected source photo to anchor its appearance.',
        'For an exact product or character, select an owned source image. Text alone cannot establish visual identity.',
      );
    return { clipId: clip.id, compiledPrompt, issues };
  });
  return creatorPromptReviewSchema.parse({
    planId: plan.id,
    workflowVersion: plan.workflowVersion,
    hasBlockingIssues: clips.some((clip) =>
      clip.issues.some((issue) => issue.severity === 'blocking'),
    ),
    clips,
  });
}
