import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilePose, sceneState } from '../public/motion.js';

test('the selected tile settles head on and fully visible on desktop and mobile', () => {
  for (const [width, height, selected] of [[1440, 900, 10], [390, 844, 7], [1024, 768, 10]]) {
    const pose = tilePose(selected, selected, 1, width, height);
    assert.equal(pose.x, 0);
    assert.equal(pose.yaw, 0);
    assert.equal(pose.opacity, 1);
    assert.ok(height / 2 + pose.y + pose.stripHeight / 2 < height, 'filmstrip stays inside viewport');
  }
});

test('all cylinder-to-strip poses stay finite, with no zero scales', () => {
  for (const width of [320, 390, 768, 1440, 2560]) {
    for (let p = 0; p <= 1; p += .025) {
      for (let i = 0; i < 21; i++) {
        const pose = tilePose(i, 10, p, width, 900, .03);
        for (const value of Object.values(pose)) assert.ok(Number.isFinite(value));
        assert.ok(pose.scale > 0 && pose.opacity >= 0 && pose.opacity <= 1);
      }
    }
  }
});

test('reduced motion can use a complete final scene directly', () => {
  assert.deepEqual(sceneState(1), { intro: 0, product: 1, device: 1, rail: 1, shade: .08000000000000002 });
});
