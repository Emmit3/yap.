import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const publicRoot = new URL('../public/', import.meta.url);
const { clips } = JSON.parse(await readFile(new URL('wall-media.json', publicRoot), 'utf8'));
const credits = JSON.parse(await readFile(new URL('media/credits.json', publicRoot), 'utf8'));
const sources = [...credits.images, ...credits.wallVideos];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('the product wall has a diverse catalog with one source per example', () => {
  assert.ok(clips.length >= 75, 'the five-row wall needs at least 75 distinct examples');
  assert.ok(
    clips.filter((clip) => clip.video).length >= 25,
    'include at least 25 real product clips',
  );
  assert.ok(
    new Set(clips.map((clip) => clip.category)).size >= 20,
    'cover different business categories',
  );
  for (const key of ['id', 'poster', 'sourceId']) {
    assert.ok(clips.every((clip) => typeof clip[key] === 'string' && clip[key].length > 0));
    assert.equal(
      new Set(clips.map((clip) => clip[key])).size,
      clips.length,
      `${key} must not repeat`,
    );
  }
  const videos = clips.filter((clip) => clip.video).map((clip) => clip.video);
  assert.equal(new Set(videos).size, videos.length, 'each video must be different');
});

test('every wall example has its own real image and an attributed source', async () => {
  const posterHashes = new Set();
  const videoHashes = new Set();
  for (const clip of clips) {
    assert.match(clip.poster, /^\/media\/[a-z0-9-]+\.jpg$/);
    const poster = await readFile(new URL(`.${clip.poster}`, publicRoot));
    assert.ok(poster.length > 2000, `${clip.id} must have a usable poster`);
    assert.equal(poster.readUInt16BE(0), 0xffd8, `${clip.id} must contain a JPEG image`);
    assert.ok(!posterHashes.has(hash(poster)), `${clip.id} repeats another image`);
    posterHashes.add(hash(poster));

    const file = (clip.video || clip.poster).split('/').at(-1);
    const entries = sources.filter((source) => source.file === file);
    assert.equal(entries.length, 1, `${clip.id} needs one source record`);
    const source = entries[0];
    assert.equal(source.sourcePage, clip.sourceUrl, `${clip.id} must link its credited source`);
    assert.match(source.licenseUrl, /^https:\/\//);
    assert.ok(source.license && source.licenseVerifiedAt && source.licenseEvidence);

    if (clip.video) {
      assert.match(clip.video, /^\/media\/[a-z0-9-]+\.mp4$/);
      const video = await readFile(new URL(`.${clip.video}`, publicRoot));
      assert.equal(video.toString('ascii', 4, 8), 'ftyp', `${clip.id} must contain an MP4`);
      const digest = hash(video);
      assert.ok(!videoHashes.has(digest), `${clip.id} repeats another video`);
      videoHashes.add(digest);
      assert.equal(source.bytes, video.length, `${clip.id} credit must match the shipped file`);
      assert.equal(source.sha256, digest, `${clip.id} credit must match the shipped video hash`);
    } else {
      assert.equal(source.bytes, poster.length, `${clip.id} credit must match the shipped image`);
      assert.equal(
        source.sha256,
        hash(poster),
        `${clip.id} credit must match the shipped image hash`,
      );
    }
  }
});
