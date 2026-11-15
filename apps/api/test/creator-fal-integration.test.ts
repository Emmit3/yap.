import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { creatorCapabilitiesSchema } from '@yap/contracts/creator';
import { createApp } from '../src/app.js';
import { createFalCreatorVideoProvider } from '../src/creator-fal-provider.js';
import {
  createConfiguredCreatorVideoProvider,
  createConfiguredCreatorVideoProviders,
  creatorVideoConfigFromEnv,
} from '../src/creator-video-factory.js';

for (const legacy of [false, true])
  test(
    legacy
      ? 'HTTP capabilities retain an explicitly selected retired fal identity without generation'
      : 'HTTP capabilities default to active Fal only even with a Runway key present',
    async (t) => {
      const prefix = join(tmpdir(), 'yap-fal-retired-');
      const directory = await mkdtemp(prefix);
      let providerCalls = 0;
      const env = { FAL_KEY: 'unused-fixture-key', RUNWAYML_API_SECRET: 'unused-runway-key' };
      const noCalls: typeof fetch = async () => {
        providerCalls++;
        throw new Error('Capabilities cannot submit provider requests');
      };
      const video = legacy
        ? createFalCreatorVideoProvider({ apiKey: 'unused-fixture-key' }, noCalls)
        : createConfiguredCreatorVideoProvider(creatorVideoConfigFromEnv(env), noCalls);
      const app = await createApp({
        dataFile: join(directory, 'projects.json'),
        workflowProviderConfig: { provider: 'guided' },
        creatorOptions: {
          video,
          videoProviders: legacy ? new Map() : createConfiguredCreatorVideoProviders(env, noCalls),
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
      assert.equal(capabilities.configured, !legacy);
      assert.equal(capabilities.provider, 'fal');
      assert.equal(capabilities.model, legacy ? 'seedance-v1.5-pro' : 'seedance-2.5');
      if (legacy) assert.match(capabilities.reason, /removed|retired/i);
      else {
        assert.equal(capabilities.videoProfiles?.filter((profile) => profile.configured).length, 2);
        assert.ok(capabilities.videoProfiles?.every((profile) => profile.provider === 'fal'));
      }
      assert.equal(providerCalls, 0);
    },
  );
