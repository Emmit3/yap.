import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CreatorClip, CreatorVideoProfileOption } from '@yap/contracts/creator';
import { ClipProviderControl } from '../src/creator/ClipProviderControl';
import { OutputProfileControl } from '../src/creator/OutputProfileControl';

// The root tsx runner uses classic JSX; Vite uses the automatic runtime in the app.
Object.assign(globalThis, { React });

const clip: CreatorClip = {
  id: randomUUID(),
  sceneId: randomUUID(),
  seconds: 5,
  prompt: 'A product shot.',
  camera: 'Still.',
  lighting: 'Soft.',
};
const turbo: CreatorVideoProfileOption = {
  id: 'runway-gen4turbo-portrait',
  label: 'Runway Gen 4 Turbo · portrait 720p',
  provider: 'runway',
  model: 'gen4_turbo',
  nativeWidth: 720,
  nativeHeight: 1280,
  ratio: '720:1280',
  minSeconds: 5,
  maxSeconds: 10,
  allowedSeconds: [5, 10],
  requiresImage: true,
  configured: true,
  rateCentsPerSecond: 5,
};
const retired: CreatorVideoProfileOption = {
  ...turbo,
  id: 'fal-seedance-v1.5-portrait',
  provider: 'fal',
  model: 'seedance-v1.5-pro',
  label: 'fal Seedance 1.5 Pro · retired',
  configured: false,
  retired: true,
  unavailableReason: 'This model was removed.',
};

test('provider controls keep retired choices disabled and explain required image and duration', () => {
  const html = renderToStaticMarkup(
    createElement(ClipProviderControl, {
      clip: { ...clip, seconds: 4, videoProfileId: turbo.id },
      profiles: [turbo, retired],
      onChange() {},
    }),
  );
  assert.match(html, /<label[^>]*for=/);
  assert.match(html, /aria-describedby=/);
  const retiredOption = html.match(
    /<option\b(?=[^>]*value="fal-seedance-v1.5-portrait")[^>]*>/,
  )?.[0];
  assert.ok(retiredOption);
  assert.match(retiredOption, /disabled/);
  assert.match(html, /Add an uploaded or approved storyboard image/);
  assert.match(html, /Save a supported shot duration/);
  assert.match(html, /720 × 1280 native pixels/);
});

test('delivery control distinguishes native canvas from resized output without changing omission', () => {
  const html = renderToStaticMarkup(createElement(OutputProfileControl, { onChange() {} }));
  assert.match(html, /value="" selected=""/);
  assert.match(html, /Portrait 720 × 1280 · native size/);
  assert.match(html, /Landscape 1280 × 720 · native size/);
  assert.match(html, /Portrait 1080 × 1920 · resized from 720p/);
  assert.match(html, /does not generate additional source detail/);
});
