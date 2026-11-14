import type { Project } from '@yap/contracts';

export function exportMarkdown(project: Project): string {
  const lines = [
    `# ${project.title}`,
    '',
    `Platform: ${project.platform} | Duration: ${project.duration}s | Status: ${project.status}`,
    '',
    '## Brief',
    '',
    project.idea,
    '',
    `Audience: ${project.audience}`,
    `Tone: ${project.tone}`,
    `Goal: ${project.goal}`,
    '',
  ];
  if (project.draft) {
    lines.push(
      '## Hook',
      '',
      project.draft.hook,
      '',
      '## Script',
      '',
      project.draft.script,
      '',
      '## Shot plan',
      '',
    );
    let elapsed = 0;
    project.draft.shots.forEach((shot, index) => {
      lines.push(
        `### Shot ${index + 1} · ${elapsed}–${elapsed + shot.seconds}s`,
        '',
        `Visual: ${shot.visual}`,
        '',
        `Voiceover: ${shot.voiceover}`,
        '',
        `On screen: ${shot.onScreenText || '(none)'}`,
        '',
      );
      elapsed += shot.seconds;
    });
    lines.push(
      '## Caption',
      '',
      project.draft.caption,
      '',
      project.draft.hashtags.join(' '),
      '',
      'Drafting method: guided template. Review and adapt before recording.',
      '',
    );
  } else lines.push('No script or shot plan has been drafted yet.', '');
  return lines.join('\n');
}

export function exportFilename(project: Project, extension: string): string {
  const stem =
    project.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'yap-project';
  return `${stem}.${extension}`;
}
