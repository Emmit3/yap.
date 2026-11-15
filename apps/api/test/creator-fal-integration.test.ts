import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { creatorCapabilitiesSchema } from '@yap/contracts/creator';
import { createApp } from '../src/app.js';
import { createFalCreatorVideoProvider } from '../src/creator-fal-provider.js';

test('HTTP capabilities report the retired default fal profile without any generation request', async (t) => {
  const prefix = join(tmpdir(), 'yap-fal-retired-');
  const directory = await mkdtemp(prefix);
  let providerCalls = 0;
  const video = createFalCreatorVideoProvider({ apiKey: 'unused-fixture-key' }, async () => {
    providerCalls++;
    throw new Error('No request may reach a retired endpoint');
  });
  const app = await createApp({
    dataFile: join(directory, 'projects.json'),
    workflowProviderConfig: { provider: 'guided' },
    creatorOptions: {
      video,
      auditor: {
        configured: false,
        audit: async () => {
          throw new Error('No paid audit');
        },
      },
      voiceover: { configured: false, narrate: async () => [] },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await app.locals.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.ok(directory.startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/creator/capabilities`);
  assert.equal(response.status, 200);
  const capabilities = creatorCapabilitiesSchema.parse(await response.json());
  assert.equal(capabilities.configured, false);
  assert.equal(capabilities.provider, 'fal');
  assert.equal(capabilities.model, 'seedance-v1.5-pro');
  assert.match(capabilities.reason, /removed|retired/i);
  assert.equal(providerCalls, 0);
});
