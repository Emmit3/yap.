import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallLayout, wrapPosition, tilePose, loadPose } from '../public/motion.js';

const viewports = [
  [320, 568],
  [390, 844],
  [700, 400],
  [768, 1024],
  [1440, 900],
  [2560, 1080],
];
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

test('the opening contains five evenly spaced rows at every supported screen size', () => {
  for (const [width, height] of viewports) {
    const layout = wallLayout(width, height);
    assert.equal(layout.rows, 5);
    assert.equal(layout.columns % 2, 1, 'each row has a center card');
    assert.equal(layout.count, layout.rows * layout.columns);
    assert.ok(layout.period > width, 'the loop has spare cards beyond the viewport');
    const rowCenters = [];
    for (let row = 0; row < 5; row++) {
      const index = row * layout.columns + Math.floor(layout.columns / 2);
      rowCenters.push(tilePose(index, index, 0, width, height).y);
    }
    assert.equal(new Set(rowCenters).size, 5);
    near(rowCenters[2], 0, 'the middle row is centered');
    for (let row = 1; row < 5; row++)
      near(
        rowCenters[row] - rowCenters[row - 1],
        rowCenters[1] - rowCenters[0],
        'row spacing is even',
      );
  }
});

test('neighboring rows pan continuously in opposite directions', () => {
  for (const [width, height] of viewports) {
    const layout = wallLayout(width, height);
    for (let row = 0; row < 5; row++) {
      const index = row * layout.columns + Math.floor(layout.columns / 2);
      const start = tilePose(index, index, 0, width, height, 0);
      const next = tilePose(index, index, 0, width, height, 1);
      assert.ok((next.x - start.x) * (row % 2 ? -1 : 1) > 0, 'row direction alternates');
      const later = tilePose(index, index, 0, width, height, 2);
      assert.ok(
        (later.x - next.x) * (row % 2 ? -1 : 1) > 0,
        'the motion keeps advancing rather than rocking back',
      );
    }
  }
});

test('wrapping is periodic and hides cards before their recycled position changes', () => {
  for (const [width, height] of viewports) {
    const layout = wallLayout(width, height);
    near(
      wrapPosition(17, layout.period),
      wrapPosition(17 + layout.period * 100, layout.period),
      'large elapsed values wrap to the same coordinate',
    );
    for (let row = 0; row < 5; row++) {
      const index = row * layout.columns + Math.floor(layout.columns / 2);
      const speed = 0.86 + row * 0.07;
      const cycle = layout.period / speed;
      const before = tilePose(index, index, 0, width, height, cycle / 2 - 0.001);
      const after = tilePose(index, index, 0, width, height, cycle / 2 + 0.001);
      near(before.opacity, 0, 'the card is invisible immediately before recycling');
      near(after.opacity, 0, 'the card is invisible immediately after recycling');
      const original = tilePose(index, index, 0, width, height, 17);
      const repeated = tilePose(index, index, 0, width, height, 17 + cycle);
      for (const property of ['x', 'y', 'z', 'yaw', 'opacity'])
        near(original[property], repeated[property], `one full pan cycle preserves ${property}`);
    }
  }
});

test('the selected tile settles inside the viewport and ignores the opening pan', () => {
  for (const [width, height] of viewports) {
    const layout = wallLayout(width, height);
    const selected = Math.floor(layout.count / 2);
    const still = tilePose(selected, selected, 1, width, height, 0);
    near(still.x, 0, 'selected card is centered');
    near(still.yaw, 0, 'selected card is head on');
    near(still.opacity, 1, 'selected card is visible');
    assert.ok(
      height / 2 + still.y + still.stripHeight / 2 < height,
      'filmstrip stays inside viewport',
    );
    const moving = tilePose(selected, selected, 1, width, height, 100000);
    for (const property of ['x', 'y', 'z', 'yaw', 'scale', 'opacity'])
      near(still[property], moving[property], `the final strip owns ${property}`);
  }
});

test('every wall-to-strip pose remains finite through wrapping and gathering', () => {
  for (const [width, height] of viewports) {
    const layout = wallLayout(width, height);
    for (const progress of [0, 0.04, 0.08, 0.2, 0.5, 0.74, 1]) {
      for (const pan of [-100000, 0, 100000]) {
        for (let index = 0; index < layout.count; index++) {
          const pose = tilePose(index, Math.floor(layout.count / 2), progress, width, height, pan);
          for (const value of Object.values(pose)) assert.ok(Number.isFinite(value));
          assert.ok(pose.scale > 0 && pose.opacity >= 0 && pose.opacity <= 1);
        }
      }
    }
  }
});

test('all five load rows settle and release the pose when scrolling early', () => {
  for (const [width, height] of viewports) {
    const { count } = wallLayout(width, height);
    for (let index = 0; index < count; index++) {
      for (const pose of [
        loadPose(1.6, index, width, height),
        loadPose(0.1, index, width, height, 0.18),
      ]) {
        for (const property of ['x', 'y', 'z', 'pitch', 'yaw', 'roll'])
          near(pose[property], 0, `${property} returns to the scene owner`);
        near(pose.scale, 1, 'load scale settles');
        near(pose.opacity, 1, 'load opacity settles');
      }
    }
  }
});
