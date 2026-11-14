import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectSchema, updateProjectSchema } from '../dist/index.js';

test('a sparse PATCH preserves omitted settings instead of applying creation defaults', () => {
  assert.deepEqual(updateProjectSchema.parse({ title: 'A new title' }), { title: 'A new title' });
  assert.deepEqual(updateProjectSchema.parse({ status: 'ready' }), { status: 'ready' });
});

test('an empty PATCH or unknown field is rejected', () => {
  assert.equal(updateProjectSchema.safeParse({}).success, false);
  assert.equal(updateProjectSchema.safeParse({ typo: 'title' }).success, false);
});

test('creation still supplies omitted optional brief settings', () => {
  const result = createProjectSchema.parse({
    title: 'Cold brew at home',
    idea: 'Show an easy cold brew coffee recipe.',
    audience: 'Home coffee drinkers',
  });
  assert.equal(result.platform, 'instagram');
  assert.equal(result.duration, 30);
  assert.equal(result.tone, 'conversational');
  assert.equal(result.goal, 'educate');
});
