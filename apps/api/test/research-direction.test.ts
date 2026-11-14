import assert from 'node:assert/strict';
import test from 'node:test';
import { socialHandoffSchema } from '@yap/contracts/social';
import { createProjectSchema } from '@yap/contracts';
import { generateGuidedDraft } from '../src/generation.js';
import { exportMarkdown } from '../src/export.js';
import { approveWorkflow, buildGuidedScript, createWorkflow, refineWorkflow, setWorkflowScript } from '../src/workflow-engine.js';

const research = socialHandoffSchema.parse({
  investigationId: '2c72c8cd-f7f3-47da-bbd8-e4e1c938ac61',
  topic: 'Coffee education',
  audience: 'People making coffee at home',
  creativeDirection: 'Adopt: Open with a question before introducing the product.',
  selectedNoteIds: [],
  selectedInsightIds: ['question-opening'],
  evidence: [{ postId: 'reference-1', url: 'https://example.com/coffee', excerpt: 'Question-led reference.' }],
  sourceUrls: ['https://example.com/coffee'],
  cautions: ['The sample cannot establish why a post received attention.'],
});

test('selected research changes presentation without repeating external product claims', () => {
  const brief = createProjectSchema.parse({
    title: 'Morning coffee',
    idea: 'Show our reusable filter and describe how to clean it.',
    audience: 'People making coffee at home',
    research,
  });
  const withResearch = generateGuidedDraft(brief);
  const baseline = generateGuidedDraft({ ...brief, research: undefined });
  assert.match(withResearch.hook, /^What should you know/);
  assert.notEqual(withResearch.hook, baseline.hook);
  assert.match(withResearch.shots[0]!.visual, /viewer question/);
  assert.doesNotMatch(withResearch.script, /Question-led reference|received attention|Adopt:/);
  assert.equal(withResearch.shots.reduce((sum, shot) => sum + shot.seconds, 0), brief.duration);
});

test('research attribution survives project validation and Markdown export', () => {
  const brief = createProjectSchema.parse({
    title: 'Morning coffee', idea: 'Show our reusable filter and describe how to clean it.',
    audience: 'People making coffee at home', research,
  });
  const markdown = exportMarkdown({
    ...brief, id: 'f6b16579-ee91-4837-b3b0-5642869c28af', status: 'draft', draft: generateGuidedDraft(brief),
    createdAt: '2026-11-13T12:00:00.000Z', updatedAt: '2026-11-13T12:00:00.000Z',
  });
  assert.match(markdown, /Research direction/);
  assert.match(markdown, /https:\/\/example.com\/coffee/);
  assert.match(markdown, /creative inspiration/);
});

test('a caution about question hooks does not become the chosen opening', () => {
  const brief = createProjectSchema.parse({
    title: 'Morning coffee', idea: 'Show our reusable filter and describe how to clean it.',
    audience: 'People making coffee at home',
    research: { ...research, creativeDirection: 'Research topic: Questions about coffee\n\nAvoid: Do not open with a question.\n\nContext: Question hooks are common.' },
  });
  assert.doesNotMatch(generateGuidedDraft(brief).hook, /^What should you know/);
});

test('avoidance overrides selected patterns and contrast survives incidental demonstration wording', () => {
  const make = (creativeDirection: string) => createProjectSchema.parse({
    title: 'Morning coffee', idea: 'Show our reusable filter and describe how to clean it.',
    audience: 'People making coffee at home', research: { ...research, creativeDirection },
  });
  assert.doesNotMatch(generateGuidedDraft(make('Selected pattern: Open with a question.\nAvoid: Do not use a question hook.')).hook, /^What should you know/);
  assert.match(generateGuidedDraft(make('Adopt: Avoid question hooks and use a comparison instead.')).hook, /look at the difference/);
  assert.match(generateGuidedDraft(make('Selected pattern: Test a clear contrast. Frame a before-and-after contrast; demonstrate the difference with your own evidence.')).hook, /look at the difference/);
});

test('promo research stays separate from product facts and revised research invalidates approval', () => {
  let workflow = createWorkflow({
    input: 'Make a short promo for our reusable filter.',
    research,
    brief: {
      productName: 'Loop filter', productDescription: 'A reusable steel coffee filter.',
      audience: 'People making coffee at home', keyBenefits: ['Rinse it after use.'],
      callToAction: 'See the filter in our store.', duration: 30,
    },
  });
  assert.equal(workflow.brief.productDescription, 'A reusable steel coffee filter.');
  workflow = approveWorkflow(workflow, 'brief');
  const script = buildGuidedScript(workflow);
  assert.match(script.hook, /^What should you know/);
  assert.doesNotMatch(script.segments.map((segment) => segment.text).join(' '), /Question-led reference|Adopt:/);
  workflow = setWorkflowScript(workflow, script);
  const next = refineWorkflow(workflow, {
    expectedVersion: workflow.version,
    research: { ...research, creativeDirection: 'Adopt: Show a demonstration first.' },
  });
  assert.equal(next.script, null);
  assert.equal(next.approvals.brief, null);
  assert.equal(next.contentRevision, workflow.contentRevision + 1);
  assert.deepEqual(next.brief, workflow.brief);
});
