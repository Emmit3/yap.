import assert from 'node:assert/strict';
import test from 'node:test';
import { observePosterPointerRelease } from '../src/posters/poster-pointer-lifecycle.js';
import {
  posterCarouselLayout,
  posterCarouselPose,
  posterDistance,
  posterIndex,
  posterTransform,
} from '../src/posters/carousel-motion.js';

test('the ring crosses catalog ends without jumping to a distant card', () => {
  assert.equal(posterIndex(-1, 22), 21);
  assert.equal(posterIndex(22, 22), 0);
  assert.equal(posterIndex(44.2, 22), 0);
  assert.equal(posterDistance(0, 21.75, 22), 0.25);
  assert.equal(posterDistance(21, 0.25, 22), -1.25);
  assert.equal(posterDistance(0, 22.25, 22), -0.25);
});

test('the selected artwork stays centered with its neighbors behind it and balanced', () => {
  const center = posterCarouselPose(5, 5, 22, 1000);
  const left = posterCarouselPose(4, 5, 22, 1000);
  const right = posterCarouselPose(6, 5, 22, 1000);
  assert.equal(center.x, 0);
  assert.equal(center.y, 0);
  assert.equal(center.z, 0);
  assert.equal(center.opacity, 1);
  assert.equal(center.visible, true);
  assert.equal(left.x, -right.x);
  assert.equal(left.yaw, -right.yaw);
  assert.equal(left.z, right.z);
  assert.ok(left.z < center.z);
  assert.ok(left.zIndex < center.zIndex);
});

test('only a bounded neighborhood is visible, including at the ring seam', () => {
  for (const position of [0, 0.5, 11, 21.75, 22.25, -0.25]) {
    const poses = Array.from({ length: 22 }, (_, index) =>
      posterCarouselPose(index, position, 22, 1000),
    );
    assert.ok(poses.filter((pose) => pose.visible).length <= 7);
    assert.ok(poses.filter((pose) => pose.visible).length >= 6);
    assert.ok(poses.every((pose) => pose.opacity >= 0 && pose.opacity <= 1));
    assert.ok(poses.filter((pose) => !pose.visible).every((pose) => pose.opacity === 0));
  }
});

test('empty and singleton catalogs never produce invalid geometry or motion', () => {
  for (const count of [0, 1]) {
    const pose = posterCarouselPose(0, 100, count, 320);
    assert.equal(posterIndex(100, count), 0);
    assert.equal(pose.x, 0);
    assert.equal(pose.z, 0);
    assert.equal(pose.visible, count === 1);
    assert.ok(!/NaN|Infinity/.test(posterTransform(pose)));
  }
  assert.equal(posterIndex(NaN, 22), 0);
  assert.equal(posterDistance(1, Infinity, 22), 0);
});

test('portrait display bounds fit a small screen and cap artwork at 220 by 320', () => {
  for (const width of [280, 320, 390, 768, 1200, 1800]) {
    const layout = posterCarouselLayout(width);
    assert.ok(layout.cardWidth <= 220 && layout.cardWidth < width);
    assert.ok(layout.cardHeight <= 320);
    assert.ok(layout.perspective > layout.radius);
  }
  assert.deepEqual(posterCarouselLayout(NaN), posterCarouselLayout(800));
});

function pointerEvent(type: string, pointerId: number) {
  return Object.assign(new Event(type), { pointerId });
}

test('an uncaptured pointer released outside the stage frees the next drag', () => {
  const outside = new EventTarget();
  const stage = new EventTarget();
  let pointer: number | null = 7;
  const stop = observePosterPointerRelease(outside, stage, (event) => {
    if (event.pointerId === null || event.pointerId === pointer) pointer = null;
  });
  outside.dispatchEvent(pointerEvent('pointerup', 8));
  assert.equal(pointer, 7, 'an unrelated pointer must not finish this session');
  outside.dispatchEvent(pointerEvent('pointerup', 7));
  assert.equal(pointer, null, 'outside release must clear the uncaptured pointer');
  pointer = 9;
  outside.dispatchEvent(pointerEvent('pointerup', 9));
  assert.equal(pointer, null, 'a second drag can also finish normally');
  stop();
});

test('cancel, lost capture and blur terminate an interrupted session and listeners clean up', () => {
  const outside = new EventTarget();
  const stage = new EventTarget();
  const endings: Array<{ pointerId: number | null; cancelled: boolean }> = [];
  const stop = observePosterPointerRelease(outside, stage, (event) => endings.push(event));
  outside.dispatchEvent(pointerEvent('pointercancel', 3));
  stage.dispatchEvent(pointerEvent('lostpointercapture', 4));
  outside.dispatchEvent(new Event('blur'));
  assert.deepEqual(
    endings.map(({ pointerId, cancelled }) => ({ pointerId, cancelled })),
    [
      { pointerId: 3, cancelled: true },
      { pointerId: 4, cancelled: true },
      { pointerId: null, cancelled: true },
    ],
  );
  stop();
  outside.dispatchEvent(pointerEvent('pointerup', 5));
  outside.dispatchEvent(pointerEvent('pointercancel', 5));
  stage.dispatchEvent(pointerEvent('lostpointercapture', 5));
  outside.dispatchEvent(new Event('blur'));
  assert.equal(endings.length, 3, 'unmounted carousels must retain no release listeners');
});
