import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { createCreatorVisionAuditor } from '../src/creator-media.js';

test('frame review normalizes PNG and WebP creator references to actual bounded JPEG bytes', async () => {
  const frame = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#555' } })
    .jpeg()
    .toBuffer();
  for (const format of ['png', 'webp'] as const) {
    const image = await sharp({
      create: { width: 1200, height: 1800, channels: 4, background: '#aaa' },
    })
      [format]()
      .toBuffer();
    let inspected = false;
    const auditor = createCreatorVisionAuditor({ apiKey: 'fixture-only' }, async (_input, init) => {
      const payload = JSON.parse(String(init?.body)),
        images = payload.input[0].content.filter(
          (item: { type: string }) => item.type === 'input_image',
        );
      assert.equal(images.length, 4);
      assert.match(images[0].image_url, /^data:image\/jpeg;base64,/);
      const bytes = Buffer.from(images[0].image_url.split(',')[1], 'base64');
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.format, 'jpeg');
      assert.ok(metadata.width! <= 640 && metadata.height! <= 640);
      inspected = true;
      return Response.json({
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  passed: true,
                  summary: 'Sampled frames match the reference.',
                  issues: [],
                }),
              },
            ],
          },
        ],
      });
    });
    const result = await auditor.audit(
      {
        id: randomUUID(),
        sceneId: randomUUID(),
        seconds: 5,
        prompt: 'A ceramic cup.',
        camera: 'Slow push in.',
        lighting: 'Soft side light.',
      },
      [frame, frame, frame],
      image,
      new AbortController().signal,
    );
    assert.equal(result.visionPassed, true);
    assert.equal(inspected, true);
  }
});
