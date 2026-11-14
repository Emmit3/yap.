import assert from 'node:assert/strict';
import test from 'node:test';
import { observePosterPointerRelease } from '../src/posters/poster-pointer-lifecycle.js';
import {
  posterCarouselLayout,
  posterCarouselPose,
  posterDistance,
  posterFocusOffset,
  posterIndex,
  posterInitialIndex,
  posterTransform,
  posterWallCell,
} from '../src/posters/carousel-motion.js';

test('logical selection wraps independently of ambient floating phase', () => {
  assert.equal(posterIndex(-1, 22), 21);
  assert.equal(posterIndex(22, 22), 0);
  assert.equal(posterIndex(44.2, 22), 0);
  assert.equal(posterDistance(0, 21.75, 22), 0.25);
  assert.equal(posterDistance(21, 0.25, 22), -1.25);
  assert.equal(posterInitialIndex(22, 1200), 11);
  assert.equal(posterInitialIndex(22, 390), 16);
});

test('each distinct poster has one balanced cell in three desktop or two mobile rows', () => {
  for (const width of [320, 1200]) {
    for (let count = 0; count <= 64; count++) {
      const layout = posterCarouselLayout(width, 640, count);
      assert.equal(layout.rows, Math.min(width < 700 ? 2 : 3, count));
      assert.equal(
        layout.rowCounts.reduce((sum, value) => sum + value, 0),
        count,
      );
      if (count) assert.ok(Math.max(...layout.rowCounts) - Math.min(...layout.rowCounts) <= 1);
      const cells = Array.from({ length: count }, (_, index) => posterWallCell(index, layout));
      assert.equal(new Set(cells.map((cell) => `${cell.row}:${cell.column}`)).size, count);
      for (let row = 0; row < layout.rows; row++) {
        assert.equal(cells.filter((cell) => cell.row === row).length, layout.rowCounts[row]);
      }
    }
  }
});

test('neighboring rows drift in opposite directions while preserving distinct depth and tilt', () => {
  const indices = [3, 11, 18];
  const before = indices.map((index) => posterCarouselPose(index, 0, 22, 1200, 640));
  const after = indices.map((index) => posterCarouselPose(index, 80, 22, 1200, 640));
  assert.ok(after[0]!.x > before[0]!.x);
  assert.ok(after[1]!.x < before[1]!.x);
  assert.ok(after[2]!.x > before[2]!.x);
  assert.equal(new Set(before.map((pose) => pose.row)).size, 3);
  assert.equal(new Set(before.map((pose) => pose.roll)).size, 3);
  assert.ok(before.every((pose) => pose.z < 0));
});

test('keyboard focus can reveal every original at any phase or pan without moving other rows', () => {
  for (const width of [320, 1200]) {
    for (const phase of [0, 1760, 100_000]) {
      for (const pan of [0, -400]) {
        for (let index = 0; index < 22; index++) {
          const focus = posterFocusOffset(index, phase, 22, width, 640, pan);
          const offsets: number[] = [];
          offsets[focus.row] = focus.offset;
          const chosen = posterCarouselPose(index, phase, 22, width, 640, pan, offsets);
          assert.ok(Math.abs(chosen.x) < 0.000001);
          assert.equal(chosen.visible, true);
          assert.equal(chosen.opacity, 1);
          assert.ok(Math.abs(chosen.projectedY) < 320);
          const neighbor = (index + 10) % 22;
          if (posterWallCell(neighbor, posterCarouselLayout(width, 640, 22)).row !== focus.row) {
            const original = posterCarouselPose(neighbor, phase, 22, width, 640, pan);
            const shifted = posterCarouselPose(neighbor, phase, 22, width, 640, pan, offsets);
            assert.equal(shifted.x, original.x);
            assert.equal(shifted.y, original.y);
          }
        }
      }
    }
  }
});

test('the floating wall has bounded finite transforms across empty, small and full catalogs', () => {
  for (const count of [0, 1, 2, 3, 22, 64]) {
    for (const phase of [0, 1000, 1_000_000]) {
      for (let index = 0; index < Math.max(1, count); index++) {
        const pose = posterCarouselPose(index, phase, count, 390, 580, -200);
        assert.ok(!/NaN|Infinity/.test(posterTransform(pose)));
        assert.ok(pose.opacity >= 0 && pose.opacity <= 1);
        assert.ok(Math.abs(pose.yaw) <= 38);
        assert.ok(Math.abs(pose.x) <= pose.radius);
        if (!count) assert.equal(pose.visible, false);
      }
    }
  }
  const visible = Array.from({ length: 22 }, (_, index) =>
    posterCarouselPose(index, 0, 22, 390, 580),
  ).filter((pose) => pose.visible);
  assert.ok(
    visible.length >= 2 && visible.length < 22,
    'offscreen artwork must be removed from interaction',
  );
});

test('a single poster stays centered with no artificial float, tilt or pan', () => {
  for (const phase of [0, 1000, 1_000_000]) {
    const pose = posterCarouselPose(0, phase, 1, 390, 640, 1000);
    assert.equal(pose.x, 0);
    assert.equal(pose.y, 0);
    assert.equal(pose.z, 0);
    assert.equal(pose.roll, 0);
    assert.equal(pose.pitch, 0);
    assert.equal(pose.visible, true);
  }
  assert.equal(posterIndex(NaN, 22), 0);
  assert.equal(posterDistance(1, Infinity, 22), 0);
});

test('portrait artwork fits the display without changing its own aspect ratio', () => {
  for (const width of [280, 320, 390, 768, 1200, 1800]) {
    const layout = posterCarouselLayout(width, 640, 22);
    assert.ok(layout.cardWidth <= 220 && layout.cardWidth < width);
    assert.ok(layout.cardHeight <= 240);
    assert.ok(layout.rowSpacing > layout.cardHeight);
  }
  assert.deepEqual(posterCarouselLayout(NaN), posterCarouselLayout(1000));
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
