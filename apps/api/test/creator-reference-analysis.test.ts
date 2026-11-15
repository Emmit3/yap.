import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import {
  createReferenceAnalysisService,
  parseReferenceTranscript,
} from '../src/creator-reference-analysis.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-reference-analysis-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    assert.ok(basename(directory).startsWith('yap-reference-analysis-'));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    sessionId: randomUUID(),
    bytes: await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#287070' } })
      .png()
      .toBuffer(),
  };
}
const transcript = {
  title: 'An attributed reference',
  sourceUrl: 'https://example.com/reference',
  format: 'vtt' as const,
  transcript:
    'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nThe opening shot.\n\n00:00:04.000 --> 00:00:07.500\nA closer detail.',
};
const approval = (record: { version: number; sourceHash: string }) => ({
  expectedVersion: record.version,
  sourceHash: record.sourceHash,
  requestId: randomUUID(),
  reviewed: true as const,
  costReviewed: true as const,
  maxCostCents: 50 as const,
});

test('VTT, SRT and timed plain imports retain supplied timestamps and reject invented timing', () => {
  assert.deepEqual(
    parseReferenceTranscript('vtt', transcript.transcript).map((c) => [c.start, c.end]),
    [
      [1, 4],
      [4, 7.5],
    ],
  );
  assert.equal(
    parseReferenceTranscript('srt', '1\n00:00:01,000 --> 00:00:03,000\nA line.')[0]!.text,
    'A line.',
  );
  assert.equal(
    parseReferenceTranscript('plain', '00:01.000 --> 00:03.000\nA timed line.')[0]!.start,
    1,
  );
  assert.throws(
    () => parseReferenceTranscript('plain', 'Words without timestamps.'),
    /explicit start/,
  );
  assert.throws(() => parseReferenceTranscript('srt', '00:00:04,000 --> 00:00:03,000\nBackwards.'));
});

test('transcripts and manual observations remain external references without configured AI', async (t) => {
  const f = await fixture(t),
    service = createReferenceAnalysisService(f.directory);
  const record = await service.import(f.sessionId, transcript);
  assert.equal(record.provenance, 'attributed_external_reference');
  assert.equal(record.analysis, undefined);
  const noted = await service.addObservation(f.sessionId, record.id, {
    expectedVersion: record.version,
    text: 'Try the opening camera rhythm.',
    atSeconds: 1,
  });
  assert.equal(noted.observations[0]!.origin, 'creator');
  assert.equal(noted.analysis, undefined);
  await assert.rejects(
    () => service.analyze(f.sessionId, record.id, approval(noted)),
    /Configure approved visual analysis/,
  );
  await assert.rejects(() =>
    service.import(f.sessionId, { ...transcript, sourceUrl: 'https://localhost/private' }),
  );
  await assert.rejects(() => service.get(randomUUID(), record.id), /not in this creation/);
});

test('visual analysis binds approved canonical frame hashes, costs and provenance and is idempotent', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const service = createReferenceAnalysisService(f.directory, {
    analyzeFrames: async (input, cost) => {
      calls++;
      assert.equal(cost.maxCostCents, 50);
      assert.equal(input.frames.length, 1);
      assert.ok(input.frames[0]!.bytes.length <= 512 * 1024);
      return {
        model: 'fixture-vision',
        summary: 'A teal background in the uploaded frame.',
        observations: [{ frameId: input.frames[0]!.id, text: 'The supplied sample uses teal.' }],
        limitations: ['Deterministic fixture response, no live AI call.'],
      };
    },
  });
  let record = await service.import(f.sessionId, transcript);
  record = await service.addFrame(f.sessionId, record.id, {
    expectedVersion: record.version,
    atSeconds: 2,
    bytes: f.bytes,
  });
  const request = approval(record),
    result = await service.analyze(f.sessionId, record.id, request);
  assert.equal(result.analysis!.sourceHash, record.sourceHash);
  assert.equal(result.observations[0]!.origin, 'ai');
  assert.equal(result.observations[0]!.atSeconds, 2);
  assert.match(result.analysis!.limitations.join(' '), /unsampled moments/);
  await service.analyze(f.sessionId, record.id, request);
  assert.equal(calls, 1);
  const changed = await service.addObservation(f.sessionId, record.id, {
    expectedVersion: result.version,
    text: 'My later manual note.',
  });
  assert.equal(changed.analysis, undefined);
  assert.equal(changed.observations.length, 1);
  assert.equal(changed.observations[0]!.origin, 'creator');
  await assert.rejects(
    () => service.analyze(f.sessionId, record.id, { ...request, requestId: randomUUID() }),
    /Reload|changed/,
  );
  assert.equal(calls, 1);
});

test('tampered reference frames fail before paid analysis', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const service = createReferenceAnalysisService(f.directory, {
    analyzeFrames: async () => {
      calls++;
      throw Error('must not be reached');
    },
  });
  let record = await service.import(f.sessionId, transcript);
  record = await service.addFrame(f.sessionId, record.id, {
    expectedVersion: record.version,
    atSeconds: 1,
    bytes: f.bytes,
  });
  await writeFile(
    join(f.directory, f.sessionId, 'reference-frames', record.id, `${record.frames[0]!.id}.jpg`),
    'tampered',
  );
  await assert.rejects(
    () => service.analyze(f.sessionId, record.id, approval(record)),
    /changed|missing/,
  );
  assert.equal(calls, 0);
});

test('changed reference snapshots discard in-flight AI results while preserving manual notes', async (t) => {
  const f = await fixture(t);
  let finish:
    | ((value: {
        model: string;
        summary: string;
        observations: Array<{ frameId: string; text: string }>;
        limitations: string[];
      }) => void)
    | undefined;
  let announceEntry: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    announceEntry = resolve;
  });
  const service = createReferenceAnalysisService(f.directory, {
    analyzeFrames: async () => {
      announceEntry();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  let record = await service.import(f.sessionId, transcript);
  record = await service.addFrame(f.sessionId, record.id, {
    expectedVersion: record.version,
    atSeconds: 2,
    bytes: f.bytes,
  });
  const pending = service.analyze(f.sessionId, record.id, approval(record));
  await entered;
  const running = await service.get(f.sessionId, record.id);
  await service.addObservation(f.sessionId, record.id, {
    expectedVersion: running.version,
    text: 'A newer manual direction.',
  });
  assert.ok(finish);
  finish({
    model: 'fixture-vision',
    summary: 'Outdated result.',
    observations: [{ frameId: record.frames[0]!.id, text: 'An old sample finding.' }],
    limitations: [],
  });
  await assert.rejects(() => pending, /changed during analysis/);
  const saved = await service.get(f.sessionId, record.id);
  assert.equal(saved.analysis, undefined);
  assert.deepEqual(
    saved.observations.map((note) => note.text),
    ['A newer manual direction.'],
  );
  assert.equal(saved.requests[0]!.status, 'failed');
});
