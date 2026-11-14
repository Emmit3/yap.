import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DOWNLOAD_SECONDS = 900;

export interface S3ExportTransport {
  upload(command: PutObjectCommand): Promise<unknown>;
  signDownload(command: GetObjectCommand, expiresIn: number): Promise<string>;
}

class S3ExportInputError extends Error {}

/** Explicit, optional export; importing this module never contacts AWS. */
export async function uploadVideoToS3(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  transport?: S3ExportTransport,
) {
  const region = env.AWS_REGION?.trim();
  const bucket = env.AWS_S3_BUCKET?.trim();
  if (!region || !bucket)
    throw new S3ExportInputError('Set AWS_REGION and AWS_S3_BUCKET in apps/api/.env first.');
  if (!filePath || extname(filePath).toLowerCase() !== '.mp4')
    throw new S3ExportInputError('Choose an existing rendered .mp4 file.');

  const file = resolve(filePath);
  const info = await stat(file).catch(() => {
    throw new S3ExportInputError('The MP4 file could not be read. Check its path.');
  });
  if (!info.isFile() || info.size === 0 || info.size > 5 * 1024 ** 3)
    throw new S3ExportInputError('The MP4 must be a nonempty regular file no larger than 5 GiB.');

  const prefix = (env.AWS_S3_PREFIX?.trim() || 'exports').replace(/^\/+|\/+$/g, '');
  const key = [prefix, `${randomUUID()}-${basename(file)}`].filter(Boolean).join('/');
  const client = transport ? undefined : new S3Client({ region });
  const io: S3ExportTransport = transport ?? {
    upload: (command) => client!.send(command),
    signDownload: (command, expiresIn) => getSignedUrl(client!, command, { expiresIn }),
  };
  const body = createReadStream(file);
  try {
    await io.upload(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: info.size,
        ContentType: 'video/mp4',
      }),
    );
    const downloadUrl = await io.signDownload(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      DOWNLOAD_SECONDS,
    );
    return { bucket, key, downloadUrl, expiresInSeconds: DOWNLOAD_SECONDS };
  } finally {
    body.destroy();
    client?.destroy();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === '--help') {
    console.log('Usage: npm run aws:upload -- <path-to-rendered.mp4>');
    if (args[0] !== '--help') process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await uploadVideoToS3(args[0]!), null, 2));
    } catch (error) {
      console.error(
        error instanceof S3ExportInputError
          ? error.message
          : 'S3 export failed. Check AWS credentials, the bucket region, and s3:PutObject/s3:GetObject access. If upload succeeded but signing failed, the object remains in S3.',
      );
      process.exitCode = 1;
    }
  }
}
