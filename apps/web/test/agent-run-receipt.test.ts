import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentRunReceipt } from '../src/AgentRunReceipt';

Object.assign(globalThis, { React });

test('historical proposals without an execution receipt claim no agent activity', () => {
  assert.equal(renderToStaticMarkup(createElement(AgentRunReceipt, { receipt: undefined })), '');
});

test('drafting receipt presents saved execution evidence and escapes review text', () => {
  const html = renderToStaticMarkup(
    createElement(AgentRunReceipt, {
      receipt: {
        harness: 'deepagents',
        model: 'gpt-6-luna',
        contextSha256: 'a'.repeat(64),
        modelCalls: 5,
        toolCalls: 7,
        specialists: ['script_writer', 'script_reviewer'],
        researchEvidenceIds: ['public-source-1'],
        researchNotes: 'Attributed context only.',
        reviewSummary: '<script>Review the creator facts.</script>',
      },
    }),
  );
  assert.match(html, /5 model calls/);
  assert.match(html, /7.*tool calls/su);
  assert.match(html, /script writer, script reviewer/);
  assert.match(html, /1 attributed research source/);
  assert.match(html, /Later edits still need your review/);
  assert.doesNotMatch(html, /<script>/);
});
