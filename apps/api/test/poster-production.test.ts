import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import {
  posterCompositionSchema,
  posterReferenceSchema,
  type PosterReference,
} from '@yap/contracts/posters';
import { ApiError } from '../src/errors.js';
import { compilePosterPlan, materializePosterArtwork } from '../src/poster-production.js';

const bytes = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#246ABC' } })
  .png()
  .toBuffer();
const sha256 = createHash('sha256').update(bytes).digest('hex');
const composition = posterCompositionSchema.parse({
  canvas: { width: 1080, height: 1440 },
  palette: ['#FFFFFF', '#246ABC'],
  artwork: [
    {
      id: 'background',
      region: { x: 0, y: 0, width: 1, height: 1 },
      treatment: 'Quiet geometric background.',
      layer: 0,
      transparentBackground: false,
    },
    {
      id: 'subject',
      region: { x: 0.1, y: 0.15, width: 0.8, height: 0.6 },
      treatment: 'One isolated original subject.',
      layer: 2,
      transparentBackground: true,
    },
  ],
  text: [
    {
      role: 'headline',
      region: { x: 0.05, y: 0.1, width: 0.9, height: 0.2 },
      fontRole: 'display',
      fontScale: 0.1,
      color: '#246ABC',
      align: 'left',
      layer: 1,
      maxCharacters: 32,
      allowArtworkOverlap: true,
    },
    {
      role: 'details',
      region: { x: 0.05, y: 0.9, width: 0.9, height: 0.05 },
      fontRole: 'body',
      fontScale: 0.02,
      color: '#246ABC',
      align: 'left',
      layer: 3,
      maxCharacters: 120,
    },
  ],
});
const reference: PosterReference = posterReferenceSchema.parse({
  id: 'geometric-study',
  title: 'Geometric study',
  category: 'campaign',
  source: { url: 'https://example.com/poster-study' },
  imageUrl: `/api/posters/references/geometric-study/image?sha256=${sha256}`,
  crop: {
    reviewedPosterOnly: true,
    reviewedAt: '2026-11-14T18:00:00.000Z',
    width: 16,
    height: 24,
    sha256,
  },
  observed: {
    provenance: 'visual_inspection',
    layout: 'Two calm geometric regions.',
    typography: 'Short headline.',
    palette: ['blue', 'white'],
    imagery: 'An original shape.',
    texture: 'Matte.',
  },
  reconstruction: {
    provenance: 'authored_from_visual_reference',
    instructions: ['Keep one focal element and a readable footer.'],
  },
  composition,
});

test('freeform directions never become approved copy and older styles need explicit layout planning', () => {
  const { composition: _composition, ...legacy } = reference;
  const plan = compilePosterPlan({
    reference: legacy,
    changes: 'Headline: Night market, Nov 28, Dock Hall.',
  });
  assert.deepEqual(plan.brief.copy, {});
  assert.equal(plan.composition, null);
  assert.deepEqual(
    plan.issues.map((issue) => issue.code),
    ['missing-composition', 'missing-headline'],
  );
});

test('composition validates complete regions and rejects duplicate roles or asset identities', () => {
  for (const invalid of [
    {
      ...composition,
      text: [{ ...composition.text[0], region: { x: 0.9, y: 0, width: 0.2, height: 0.2 } }],
    },
    { ...composition, text: [composition.text[0], composition.text[0]] },
    { ...composition, artwork: [composition.artwork[0], composition.artwork[0]] },
  ])
    assert.equal(posterCompositionSchema.safeParse(invalid).success, false);
});

test('exact copy is retained, layout intent stays immutable, and every production change has a new fingerprint', () => {
  const brief = { copy: { headline: '  NIGHT SHIFT\nMARKET  ', details: 'NOV 28 · DOCK HALL' } };
  const plan = compilePosterPlan({ reference, changes: 'Use blue.', brief });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.brief.copy.headline, brief.copy.headline);
  assert.equal(
    compilePosterPlan({ reference, changes: 'Use blue.', brief }).fingerprint,
    plan.fingerprint,
  );
  const variations = [
    compilePosterPlan({ reference, changes: 'Use red.', brief }),
    compilePosterPlan({
      reference,
      changes: 'Use blue.',
      brief: { copy: { headline: 'DAY SHIFT' } },
    }),
    compilePosterPlan({
      reference,
      changes: 'Use blue.',
      brief: { ...brief, canvas: { width: 1080, height: 1920 } },
    }),
    compilePosterPlan({
      reference: { ...reference, crop: { ...reference.crop, sha256: 'b'.repeat(64) } },
      changes: 'Use blue.',
      brief,
    }),
  ];
  assert.equal(
    new Set([plan.fingerprint, ...variations.map((value) => value.fingerprint)]).size,
    5,
  );
  assert.deepEqual(reference.composition?.canvas, { width: 1080, height: 1440 });
});

test('copy cannot silently overflow or disappear into an unsupported slot', () => {
  const plan = compilePosterPlan({
    reference,
    changes: 'Keep the design.',
    brief: { copy: { headline: 'A'.repeat(33), subheading: 'Do not lose these words.' } },
  });
  assert.deepEqual(plan.issues, [
    { code: 'copy-exceeds-slot', role: 'headline' },
    { code: 'unsupported-copy-role', role: 'subheading' },
  ]);
});

test('materialization supplies real hash-checked image bytes, separate artwork requests and exact text layers', async () => {
  const plan = compilePosterPlan({
    reference,
    changes: 'Use an original geometric subject.',
    brief: { copy: { headline: 'NIGHT SHIFT', details: 'NOV 28\nDOCK HALL' } },
  });
  const input = await materializePosterArtwork(plan, reference, async (id, hash) => {
    assert.equal(id, reference.id);
    assert.equal(hash, sha256);
    return { data: bytes, sha256, mimeType: 'image/png' };
  });
  assert.deepEqual(input.images[0]?.bytes, bytes);
  assert.equal(input.artworkRequests.length, 2);
  assert.equal(input.artworkRequests[1]?.transparentBackground, true);
  assert.deepEqual(
    input.textLayers.map(({ text, layer }) => ({ text, layer })),
    [
      { text: 'NIGHT SHIFT', layer: 1 },
      { text: 'NOV 28\nDOCK HALL', layer: 3 },
    ],
  );
  const prompt = input.artworkRequests[0]!.prompt;
  assert.equal(prompt.includes('/api/posters/'), false);
  assert.equal(prompt.includes('NIGHT SHIFT'), false);
  const data = JSON.parse(prompt.split('\n').at(-1)!);
  assert.deepEqual(
    data.reservedTextRegions.map((slot: { role: string }) => slot.role),
    ['details'],
  );
});

test('incomplete, stale, tampered or replaced input fails before production', async () => {
  const complete = compilePosterPlan({
    reference,
    changes: 'Use blue.',
    brief: { copy: { headline: 'NIGHT SHIFT' } },
  });
  let loads = 0;
  const loader = async () => {
    loads++;
    return { data: bytes, sha256, mimeType: 'image/png' };
  };
  for (const invalid of [
    compilePosterPlan({ reference, changes: 'Use blue.' }),
    { ...complete, changes: 'Different direction.' },
    { ...complete, fingerprint: 'a'.repeat(64) },
  ])
    await assert.rejects(
      () => materializePosterArtwork(invalid, reference, loader),
      (error: unknown) => error instanceof ApiError && error.status === 409,
    );
  assert.equal(loads, 0);
  const changedRecipe = {
    ...reference,
    reconstruction: {
      ...reference.reconstruction,
      instructions: ['Use a completely different subject and medium.'],
    },
  };
  await assert.rejects(
    () => materializePosterArtwork(complete, changedRecipe, loader),
    (error: unknown) => error instanceof ApiError && error.code === 'POSTER_PLAN_CHANGED',
  );
  assert.equal(loads, 0);
  await assert.rejects(
    () =>
      materializePosterArtwork(complete, reference, async () => ({
        data: Buffer.from('replaced'),
        sha256,
        mimeType: 'image/png',
      })),
    (error: unknown) => error instanceof ApiError && error.code === 'POSTER_REFERENCE_CHANGED',
  );
});
