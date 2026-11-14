import { apiErrorSchema } from '@yap/contracts';

const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
export const CREATOR_VIDEO_DOWNLOAD_TIMEOUT_MS = 90_000;

export class CreatorDownloadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'CreatorDownloadError';
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new CreatorDownloadError(
      'The download exceeded its saved size limit. Reload the saved film before trying again.',
      'DOWNLOAD_SIZE_LIMIT',
      response.status,
    );
  }
  if (!response.body)
    throw new CreatorDownloadError(
      'The server returned an empty download. Try again.',
      'DOWNLOAD_EMPTY',
      response.status,
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes)
        throw new CreatorDownloadError(
          'The download exceeded its saved size limit. Reload the saved film before trying again.',
          'DOWNLOAD_SIZE_LIMIT',
          response.status,
        );
      chunks.push(new Uint8Array(next.value));
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetches the exact reviewed MP4; callers save a Blob only after all checks finish. */
export async function fetchCreatorVideo(
  url: string,
  expected: { bytes: number; sha256: string },
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<Blob> {
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1 ||
    expected.bytes > MAX_VIDEO_BYTES ||
    !/^[a-f0-9]{64}$/i.test(expected.sha256)
  )
    throw new CreatorDownloadError(
      'The saved video receipt is invalid or exceeds the 256 MiB download limit. Reload the film before downloading.',
      'DOWNLOAD_INVALID_RECEIPT',
    );
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () =>
    controller.abort(
      new CreatorDownloadError('Download canceled. No file was saved.', 'DOWNLOAD_CANCELED'),
    );
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new CreatorDownloadError(
        'The download timed out. Try downloading the saved film again.',
        'DOWNLOAD_TIMEOUT',
      ),
    );
  }, CREATOR_VIDEO_DOWNLOAD_TIMEOUT_MS);
  try {
    controller.signal.throwIfAborted();
    const response = await abortable(
      transport(url, { signal: controller.signal }),
      controller.signal,
    );
    if (!response.ok) {
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder().decode(await readBounded(response, MAX_ERROR_BYTES, controller.signal)),
        );
      } catch {
        if (controller.signal.aborted) controller.signal.throwIfAborted();
      }
      const error = apiErrorSchema.safeParse(value);
      if (error.success) {
        const details = error.data.error.details
          ?.map((item) => `${item.path}: ${item.message}`)
          .join(' ');
        throw new CreatorDownloadError(
          `${error.data.error.message}${details ? ` ${details}` : ''}`.slice(0, 4000),
          error.data.error.code,
          response.status,
        );
      }
      throw new CreatorDownloadError(
        `The film could not be downloaded (${response.status}). Reload the saved studio and try again.`,
        'DOWNLOAD_HTTP_ERROR',
        response.status,
      );
    }
    if (
      response.status !== 200 ||
      !/^video\/mp4(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new CreatorDownloadError(
        'The server did not return a complete MP4. Reload the saved film before trying again.',
        'DOWNLOAD_INVALID_TYPE',
        response.status,
      );
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && Number(declared) !== expected.bytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new CreatorDownloadError(
        'The download size does not match the saved video. Reload the film before downloading.',
        'DOWNLOAD_SIZE_MISMATCH',
        response.status,
      );
    }
    const bytes = await readBounded(response, expected.bytes, controller.signal);
    if (bytes.byteLength !== expected.bytes)
      throw new CreatorDownloadError(
        'The download ended before the whole film arrived. Try downloading it again.',
        'DOWNLOAD_TRUNCATED',
        response.status,
      );
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await abortable(subtle.digest('SHA-256', bytes), controller.signal);
      const hash = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
      if (hash !== expected.sha256.toLowerCase())
        throw new CreatorDownloadError(
          'The downloaded film failed its integrity check. Reload the saved studio before trying again.',
          'DOWNLOAD_INTEGRITY',
          response.status,
        );
    }
    controller.signal.throwIfAborted();
    return new Blob([bytes], { type: 'video/mp4' });
  } catch (error) {
    if (controller.signal.aborted)
      throw new CreatorDownloadError(
        timedOut
          ? 'The download timed out. Try downloading the saved film again.'
          : 'Download canceled. No file was saved.',
        timedOut ? 'DOWNLOAD_TIMEOUT' : 'DOWNLOAD_CANCELED',
      );
    if (error instanceof CreatorDownloadError) throw error;
    throw new CreatorDownloadError(
      'The download was interrupted or could not reach the server. Try downloading the saved film again.',
      'DOWNLOAD_NETWORK',
    );
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
  }
}
