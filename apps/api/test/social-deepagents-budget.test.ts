import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { socialResearchRunInputSchema, socialDatasetSchema } from '@yap/contracts/social';
import { CreatorRepository } from '../src/creator-repository.js';
import { createCreatorPaidRequests } from '../src/creator-paid-requests.js';
import { runSocialDeepAgents } from '../src/social-deepagents.js';

test('the real Deep Agents model client submits through the durable paid gate without automatic retries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yap-harness-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'creator.json');
  const ledger = await CreatorRepository.open(file);
  let calls = 0;
  const gate = createCreatorPaidRequests(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    assert.equal(
      (await ledger.budget()).reservedCents,
      50,
      'funds are durable before the model POST',
    );
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.max_completion_tokens, 1500);
    throw new Error('Simulated uncertain provider disconnect.');
  });
  gate.attach(ledger);
  await assert.rejects(
    runSocialDeepAgents(
      {
        input: socialResearchRunInputSchema.parse({
          topic: 'Ceramic product films',
          platforms: ['web'],
          mode: 'live',
          harness: 'deepagents',
          limit: 5,
        }),
        signal: new AbortController().signal,
        emit: () => {},
        writeArtifact: () => {},
        collect: async () =>
          socialDatasetSchema.parse({ posts: [], actors: [], relationships: [], warnings: [] }),
      },
      {
        config: {
          model: 'gpt-6-luna',
          apiKey: 'fixture-not-a-live-key',
          timeoutMs: 10000,
          maxModelCalls: 2,
        },
        fetch: gate.fetch,
      },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(
    (await (await CreatorRepository.open(file)).budget()).reservedCents,
    50,
    'an uncertain model submission retains its hold after restart',
  );
});
