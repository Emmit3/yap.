import type { SocialHandoff } from '@yap/contracts/social';

export type ResearchHookStyle = 'question' | 'demonstration' | 'contrast' | 'direct';

/** External references guide presentation. They never supply product claims. */
export function researchHookStyle(research?: SocialHandoff): ResearchHookStyle | null {
  if (!research) return null;
  const lines = research.creativeDirection.split(/\n+/);
  const selected = lines.filter((line) => /^(selected pattern|adopt|test):/i.test(line));
  const patterns: Record<Exclude<ResearchHookStyle, 'direct'>, RegExp> = {
    contrast: /\b(contrast|before|after|compare|comparison)\b/,
    question: /\b(questions?|ask(?:ing)?|curiosity)\b/,
    demonstration: /\b(demonstrat\w*|show(?:ing)?|visual|proof|process)\b/,
  };
  const banned = new Set<ResearchHookStyle>();
  for (const line of lines.filter((item) => /^avoid:/i.test(item))) {
    for (const [style, pattern] of Object.entries(patterns)) {
      if (pattern.test(line.toLowerCase())) banned.add(style as ResearchHookStyle);
    }
  }
  const positive = selected.length ? selected : lines.some((line) => /^(avoid|context):/i.test(line)) ? [] : lines;
  const clauses = positive.flatMap((line) => line.toLowerCase().split(/[.;]|\b(?:and|but)\b/));
  for (const clause of clauses) {
    for (const [style, pattern] of Object.entries(patterns)) {
      const match = pattern.exec(clause);
      if (match && /\b(avoid|never|without|no|not|don't)\b/.test(clause.slice(0, match.index))) {
        banned.add(style as ResearchHookStyle);
      }
    }
  }
  const direction = clauses.join(' ');
  // Specific comparison framing takes precedence over an incidental "demonstrate".
  for (const [style, pattern] of Object.entries(patterns)) {
    if (!banned.has(style as ResearchHookStyle) && pattern.test(direction)) return style as ResearchHookStyle;
  }
  return 'direct';
}

export function researchHook(topic: string, research?: SocialHandoff): string | null {
  const subject = topic.charAt(0).toLowerCase() + topic.slice(1);
  switch (researchHookStyle(research)) {
    case 'question':
      return `What should you know about ${subject}?`;
    case 'demonstration':
      return `Let me show you ${subject}.`;
    case 'contrast':
      return `${topic}: look at the difference.`;
    case 'direct':
      return `Here is the idea behind ${subject}.`;
    default:
      return null;
  }
}

export function researchVisualDirection(research?: SocialHandoff): string {
  switch (researchHookStyle(research)) {
    case 'question':
      return ' Frame the opening around one clear viewer question.';
    case 'demonstration':
      return ' Show the subject or process immediately using material the creator can verify.';
    case 'contrast':
      return ' Use a comparison only when the creator has footage or evidence for both sides.';
    case 'direct':
      return ' Keep the opening focused on one concrete idea.';
    default:
      return '';
  }
}
