import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueReels, reelSelection } from '../public/catalog.js';
import { wallLayout, wallCell, tilePose, loadPose } from '../public/motion.js';

const baseUrl = 'https://yap.example/showcase/app.js';
const catalog = (length) =>
  uniqueReels(
    Array.from({ length }, (_, index) => ({
      title: `Product study ${index + 1}`,
      poster: `/media/product-${index}.jpg`,
      video: index % 10 === 0 ? `/media/product-${index}.mp4` : null,
      sourceId: `photo:${index}`,
      sourceUrl: `https://stock.example/photos/${index}`,
    })),
    baseUrl,
  );

test('a partial catalog filters malformed entries and repeated posters, films, and sources', () => {
  const originals = catalog(4);
  const normalized = uniqueReels(
    [
      null,
      {},
      { title: 'Missing poster' },
      { title: 'Invalid poster', poster: 'javascript:alert(1)' },
      originals[0],
      { ...originals[1], poster: './media/product-0.jpg?crop=square' },
      { ...originals[1], video: '/media/product-0.mp4#alternate' },
      { ...originals[1], sourceUrl: 'https://stock.example/photos/0?tracking=other' },
      { ...originals[1], sourceId: originals[0].sourceId },
      ...originals.slice(1),
    ],
    baseUrl,
  );
  assert.deepEqual(normalized, originals);
  assert.equal(normalized[0].poster, 'https://yap.example/showcase/media/product-0.jpg');
  assert.equal(normalized[1].video, null, 'a still has no substituted sample film');
  assert.deepEqual(uniqueReels({ clips: originals }, baseUrl), []);
  assert.deepEqual(uniqueReels([], baseUrl), []);
});

test('the wall and phone use the same unique entries within the actual viewport capacity', () => {
  for (const capacity of [12, 75, 96]) {
    const reels = catalog(capacity);
    for (const [width, height] of [
      [390, 844],
      [1440, 900],
      [2560, 1080],
      [3440, 1440],
      [100000, 900],
    ]) {
      const layout = wallLayout(width, height, reels.length);
      const shown = reels.slice(0, layout.count);
      assert.equal(layout.count, Math.min(wallLayout(width, height).count, reels.length));
      assert.equal(new Set(shown.map((reel) => reel.poster)).size, layout.count);
      assert.equal(
        layout.rowCounts.reduce((sum, count) => sum + count, 0),
        layout.count,
      );
      assert.equal(layout.rows, 5);
      assert.ok(Math.max(...layout.rowCounts) - Math.min(...layout.rowCounts) <= 1);
      const cells = new Set();
      shown.forEach((reel, index) => {
        const selection = reelSelection(reels, index, layout.count);
        assert.equal(
          selection.reel,
          reel,
          'the phone and full preview keep the selected wall media',
        );
        assert.equal(selection.index, index);
        assert.equal(selection.count, shown.length, 'the counter describes selectable tiles');
        assert.equal(selection.hasPrevious, index > 0);
        assert.equal(selection.hasNext, index < shown.length - 1);
        const cell = wallCell(index, layout);
        assert.ok(cell.row >= 0 && cell.row < 5);
        cells.add(`${cell.row}:${cell.column}`);
      });
      assert.equal(cells.size, shown.length, 'every distinct item has exactly one wall position');
      assert.equal(reelSelection(reels, 1e6, layout.count).reel, shown.at(-1));
      assert.equal(reelSelection(reels, -1, layout.count).reel, shown[0]);
    }
  }
});

test('the twelve-image fallback keeps five rows and alternating motion without repeated tiles', () => {
  const capacity = 12;
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
    [2560, 1080],
    [3440, 1440],
  ]) {
    const layout = wallLayout(width, height, capacity);
    assert.equal(layout.count, capacity);
    const rowCenters = [];
    let index = 0;
    for (const rowCount of layout.rowCounts) {
      const center = index + Math.floor(rowCount / 2);
      const cell = wallCell(center, layout);
      const still = tilePose(center, center, 0, width, height, 0, capacity);
      const moving = tilePose(center, center, 0, width, height, 1, capacity);
      assert.ok((moving.x - still.x) * (cell.row % 2 ? -1 : 1) > 0);
      const cycle = cell.period / (0.86 + cell.row * 0.07);
      const repeated = tilePose(center, center, 0, width, height, cycle, capacity);
      assert.ok(Math.abs(still.x - repeated.x) < 1e-6, 'each ragged row wraps at its own period');
      rowCenters.push(still.y);
      index += rowCount;
    }
    assert.equal(new Set(rowCenters).size, 5);
    assert.equal(rowCenters[2], 0);
  }
});

test('short or empty catalogs do not invent items and every valid tile pose stays finite', () => {
  assert.equal(wallLayout(1440, 900, 0).count, 0);
  assert.deepEqual(reelSelection([], 3), {
    index: -1,
    count: 0,
    reel: null,
    hasPrevious: false,
    hasNext: false,
  });
  for (const capacity of [1, 2, 4, 12, 75]) {
    const layout = wallLayout(3440, 1440, capacity);
    assert.equal(layout.count, capacity);
    for (let index = 0; index < layout.count; index++) {
      for (const progress of [0, 0.2, 0.5, 1]) {
        for (const pose of [
          tilePose(index, index, progress, 3440, 1440, 100000, capacity),
          loadPose(0.4, index, 3440, 1440, progress, capacity),
        ]) {
          for (const value of Object.values(pose)) assert.ok(Number.isFinite(value));
          assert.ok(pose.scale > 0);
        }
      }
      const settled = tilePose(index, index, 1, 3440, 1440, 0, capacity);
      assert.equal(settled.x, 0);
      assert.equal(settled.yaw, 0);
      assert.equal(settled.opacity, 1);
    }
  }
});
