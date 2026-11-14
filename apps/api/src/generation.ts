import { randomUUID } from 'node:crypto';
import { videoDraftSchema, type ProjectBrief, type VideoDraft } from '@yap/contracts';

function words(text: string, limit: number): string {
  const raw = text.replace(/\s+/g, ' ').trim();
  const characterLimit = Math.min(limit * 20, 1000);
  const normalized = raw.length > characterLimit ? `${raw.slice(0, characterLimit - 1)}…` : raw;
  const parts = normalized.split(' ');
  return parts.length > limit
    ? `${parts
        .slice(0, limit)
        .join(' ')
        .replace(/[,:;.!?]+$/, '')}…`
    : normalized;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** Deterministic drafting aid. It rearranges the supplied brief and never invents research or renders video. */
export function generateGuidedDraft(brief: ProjectBrief): VideoDraft {
  const topic = words(brief.title, 10).replace(/[.!?]+$/, '');
  const idea = brief.idea.replace(/\s+/g, ' ').trim();
  const count = brief.duration === 15 ? 3 : brief.duration === 30 ? 4 : 6;
  const hook =
    brief.tone === 'bold'
      ? `${topic}. Start here.`
      : brief.tone === 'educational'
        ? `A quick guide to ${topic.charAt(0).toLowerCase()}${topic.slice(1)}.`
        : `Let's talk about ${topic.charAt(0).toLowerCase()}${topic.slice(1)}.`;
  const closing =
    brief.goal === 'promote'
      ? 'Take a closer look and decide if this is right for you.'
      : brief.goal === 'entertain'
        ? 'Send this to someone who would get it.'
        : 'Save this idea and try it for yourself.';
  const detailCount = count - 2;
  const budget = brief.duration === 15 ? 18 : brief.duration === 30 ? 48 : 108;
  const detailWords = words(idea, budget).split(' ');
  const chunkSize = Math.max(1, Math.ceil(detailWords.length / detailCount));
  const details = Array.from({ length: detailCount }, (_, index) => {
    const chunk = detailWords.slice(index * chunkSize, (index + 1) * chunkSize).join(' ');
    return chunk ? sentence(chunk) : `Keep this practical for ${words(brief.audience, 10)}.`;
  });
  const voiceovers = [hook, ...details, closing];
  const baseSeconds = Math.floor(brief.duration / count);
  const remainder = brief.duration % count;
  const shots = voiceovers.map((voiceover, index) => ({
    id: randomUUID(),
    seconds: baseSeconds + (index < remainder ? 1 : 0),
    visual:
      index === 0
        ? `Open on camera with a clear view of the subject: ${topic}.`
        : index === count - 1
          ? 'Return to camera and leave a moment for the closing message.'
          : `Film a close view that illustrates: ${words(voiceover, 18)}`,
    voiceover,
    onScreenText:
      index === 0 ? words(topic, 8) : index === count - 1 ? words(closing, 8) : words(voiceover, 7),
  }));
  const keywords = topic.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
  const hashtags = [
    ...new Set([
      ...keywords.slice(0, 3).map((word) => `#${word.slice(0, 80)}`),
      '#creators',
      brief.platform === 'youtube'
        ? '#shorts'
        : brief.platform === 'instagram'
          ? '#reels'
          : '#tiktok',
    ]),
  ];
  return videoDraftSchema.parse({
    hook,
    script: voiceovers.join('\n\n'),
    caption: `${sentence(words(idea, 55))}\n\n${closing}`,
    hashtags,
    shots,
    provider: 'guided',
    generatedAt: new Date().toISOString(),
  });
}
