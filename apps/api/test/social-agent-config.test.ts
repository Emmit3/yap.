import assert from 'node:assert/strict';
import test from 'node:test';
import { configFromEnv, socialDeepAgentsAvailable } from '../src/social-agent-config.js';

test('agent configuration defaults to the bounded model while still requiring a server key', () => {
  assert.equal(configFromEnv({}).model, 'gpt-6-luna');
  assert.equal(socialDeepAgentsAvailable(configFromEnv({})).configured, false);
  const configured = configFromEnv({ OPENAI_API_KEY: 'local-test-key', DEEPAGENTS_MODEL: ' ' });
  assert.equal(configured.model, 'gpt-6-luna');
  assert.equal(socialDeepAgentsAvailable(configured).configured, true);
});

test('provider-qualified model names normalize before budgeting and the agent key overrides OpenAI', () => {
  assert.deepEqual(
    configFromEnv({
      DEEPAGENTS_MODEL: ' openai:gpt-6-luna ',
      OPENAI_API_KEY: 'general-local-key',
      DEEPAGENTS_OPENAI_API_KEY: ' agent-local-key ',
    }),
    { model: 'gpt-6-luna', apiKey: 'agent-local-key' },
  );
});
