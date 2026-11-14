import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { uploadVideoToS3, type S3ExportTransport } from '../src/s3-export.js';

const env = { AWS_REGION: 'us-east-1', AWS_S3_BUCKET: 'test-yap-exports' };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yap-s3-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'promo.mp4');
  const bytes = Buffer.from('rendered-video-test-bytes');
  await writeFile(file, bytes);
  return { directory, file, bytes };
}

test('S3 export uploads the selected bytes privately and signs the matching download', async (t) => {
  const f = await fixture(t);
  let uploadedKey: string | undefined;
  const result = await uploadVideoToS3(
    f.file,
    { ...env, AWS_S3_PREFIX: '/promos/' },
    {
      async upload(command) {
        assert.equal(command.input.Bucket, env.AWS_S3_BUCKET);
        assert.equal(command.input.ContentType, 'video/mp4');
        assert.equal(command.input.ContentLength, f.bytes.length);
        assert.equal(command.input.ACL, undefined);
        uploadedKey = command.input.Key;
        assert.match(uploadedKey!, /^promos\/[0-9a-f-]+-promo\.mp4$/);
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body as ReadStream) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), f.bytes);
      },
      async signDownload(command, expiresIn) {
        assert.equal(command.input.Bucket, env.AWS_S3_BUCKET);
        assert.equal(command.input.Key, uploadedKey);
        assert.equal(expiresIn, 900);
        return 'https://test.example/presigned-download';
      },
    },
  );
  assert.deepEqual(result, {
    bucket: env.AWS_S3_BUCKET,
    key: uploadedKey,
    downloadUrl: 'https://test.example/presigned-download',
    expiresInSeconds: 900,
  });
});

test('invalid configuration and files fail before any AWS request', async (t) => {
  const f = await fixture(t);
  const noNetwork: S3ExportTransport = {
    async upload() {
      assert.fail('Invalid input must never upload.');
    },
    async signDownload() {
      assert.fail('Invalid input must never sign a URL.');
    },
  };
  await assert.rejects(uploadVideoToS3(f.file, {}, noNetwork), /AWS_REGION and AWS_S3_BUCKET/);
  await assert.rejects(uploadVideoToS3('photo.png', env, noNetwork), /rendered \.mp4/);
  await assert.rejects(uploadVideoToS3(join(f.directory, 'missing.mp4'), env, noNetwork), /path/);
  const empty = join(f.directory, 'empty.mp4');
  await writeFile(empty, '');
  await assert.rejects(uploadVideoToS3(empty, env, noNetwork), /nonempty regular file/);
  const directory = join(f.directory, 'directory.mp4');
  await mkdir(directory);
  await assert.rejects(uploadVideoToS3(directory, env, noNetwork), /nonempty regular file/);
});

test('an upload failure is propagated without signing a download', async (t) => {
  const f = await fixture(t);
  const failure = new Error('Injected upload failure');
  await assert.rejects(
    uploadVideoToS3(f.file, env, {
      async upload() {
        throw failure;
      },
      async signDownload() {
        assert.fail('A failed upload must not produce a download link.');
      },
    }),
    failure,
  );
});
