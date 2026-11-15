import assert from 'node:assert/strict';
import test from 'node:test';
import type { SocialResearchCapabilities } from '@yap/contracts/social';
import {
  applyResearchEngineDefault,
  chooseResearchEngine,
  initialResearchEngine,
} from '../src/social/research-engine.js';

const capabilities: SocialResearchCapabilities = {
  defaultHarness: 'deepagents',
  demoReplay: true,
  pollIntervalMs: 750,
  harnesses: [
    { id: 'pipeline', name: 'Direct search', configured: true, description: '', limitations: [] },
    { id: 'deepagents', name: 'Deep Agents', configured: true, description: '', limitations: [] },
  ],
};

test('configured server default selects real agents without creating a dirty form', () => {
  const selection = applyResearchEngineDefault(initialResearchEngine, capabilities);
  assert.equal(selection.value, 'deepagents');
  assert.equal(selection.value, selection.baseline);
  assert.equal(selection.explicit, false);
});

test('a creator choice remains selected when capabilities refresh', () => {
  const defaulted = applyResearchEngineDefault(initialResearchEngine, capabilities);
  const direct = chooseResearchEngine(defaulted, 'pipeline');
  assert.equal(applyResearchEngineDefault(direct, capabilities), direct);
  assert.notEqual(direct.value, direct.baseline);
  const original = chooseResearchEngine(direct, 'deepagents');
  assert.equal(original.value, original.baseline);
  assert.equal(
    applyResearchEngineDefault(original, { ...capabilities, defaultHarness: 'pipeline' }),
    original,
  );
});

test('unavailable agent defaults stay on the direct engine without claiming configured execution', () => {
  const unavailable = {
    ...capabilities,
    harnesses: capabilities.harnesses.map((item) => ({ ...item, configured: false })),
  };
  const selection = applyResearchEngineDefault(initialResearchEngine, unavailable);
  assert.equal(selection.value, 'pipeline');
  assert.equal(selection.value, selection.baseline);
});
