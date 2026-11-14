import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import {
  workflowSchema,
  type Workflow,
  type WorkflowImageAsset,
  type WorkflowScene,
} from '@yap/contracts/workflow';
import { ApiError } from './errors.js';

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 24;
const MAX_PIXELS = 40_000_000;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
// ffmpeg-static is CommonJS; its declaration file is ambiguous under NodeNext.
const installedEncoder: unknown = createRequire(import.meta.url)('ffmpeg-static');
const ffmpegStatic = typeof installedEncoder === 'string' ? installedEncoder : null;

export interface RenderOptions {
  workflow: Workflow;
  outputPath: string;
  loadAsset(asset: WorkflowImageAsset): Promise<Buffer>;
  ffmpegPath?: string;
  /** Exclusive, direct child of the output directory, so interrupted jobs can be recovered. */
  workDirectory?: string;
  signal?: AbortSignal;
  /** Fraction between zero and one. This callback must not throw. */
  onProgress?(progress: number): void;
}

export interface RenderResult {
  bytes: number;
  sha256: string;
  width: 1080;
  height: 1920;
  duration: number;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ApiError(409, 'RENDER_CANCELLED', 'The video render was cancelled.');
}

function xml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character]!,
  );
}

/** Bound both text length and line count before constructing an SVG text node. */
function lines(value: string, limit: number, lineCount: number): string[] {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = clean
    .slice(0, limit * lineCount * 2)
    .split(' ')
    .filter(Boolean);
  const result: string[] = [];
  let line = '';
  let clipped = clean.length > limit * lineCount * 2;
  for (const word of words) {
    const pieces =
      word.length > limit ? (word.match(new RegExp(`.{1,${limit}}`, 'gu')) ?? []) : [word];
    for (const piece of pieces) {
      if (line && Array.from(`${line} ${piece}`).length > limit) {
        result.push(line);
        line = '';
      }
      if (result.length >= lineCount) {
        clipped = true;
        break;
      }
      line = line ? `${line} ${piece}` : piece;
    }
    if (result.length >= lineCount) break;
  }
  if (line && result.length < lineCount) result.push(line);
  if (clipped && result.length)
    result[result.length - 1] = `${Array.from(result[result.length - 1]!)
      .slice(0, limit - 1)
      .join('')
      .replace(/[ .,;:!?]+$/, '')}…`;
  return result;
}

function textBlock(
  text: string[],
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  fill: string,
  weight = 600,
): string {
  return text
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * lineHeight}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${xml(line)}</text>`,
    )
    .join('');
}

function overlay(workflow: Workflow, scene: WorkflowScene, index: number): Buffer {
  const brand = workflow.brief.productName ?? workflow.title;
  const last = index === workflow.scenes!.scenes.length - 1;
  const segment = workflow.script!.segments.find((item) => item.id === scene.scriptSegmentId)!;
  const headline = scene.onScreenText.trim() || segment.text;
  const captionLines = lines(headline, 25, 3);
  const cta = workflow.brief.callToAction?.trim() ?? '';
  const extraCta = last && cta && !headline.toLocaleLowerCase().includes(cta.toLocaleLowerCase());
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <rect x="0" y="1280" width="1080" height="640" fill="#101a13" opacity="0.94"/>
    <rect x="80" y="1320" width="88" height="6" rx="3" fill="#d4e8b7"/>
    <g font-family="Segoe UI, DejaVu Sans, sans-serif" letter-spacing="-1">
      ${textBlock(lines(brand, 30, 2), 80, 132, 48, 60, '#ffffff', 650)}
      ${textBlock(captionLines, 80, 1430, 66, 82, '#ffffff', 600)}
      ${extraCta ? `<rect x="80" y="1710" width="920" height="112" rx="24" fill="#d4e8b7"/>${textBlock(lines(cta, 44, 2), 112, 1758, 32, 40, '#17231a', 600)}` : ''}
    </g>
  </svg>`);
}

async function photoFrame(photo: Buffer): Promise<Buffer> {
  const image = sharp(photo, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1) {
    throw new ApiError(
      400,
      'RENDER_INVALID_IMAGE',
      'Use a still PNG, JPEG, or WebP image for the video.',
    );
  }
  const background = await image
    .clone()
    .rotate()
    .resize(WIDTH, HEIGHT, { fit: 'cover' })
    .blur(40)
    .modulate({ brightness: 0.45, saturation: 0.8 })
    .png()
    .toBuffer();
  const foreground = await image
    .clone()
    .rotate()
    .resize(920, 1000, { fit: 'cover', position: sharp.strategy.attention })
    .png()
    .toBuffer();
  const rounded = await sharp(foreground)
    .composite([
      {
        input: Buffer.from(
          '<svg width="920" height="1000"><rect width="920" height="1000" rx="28" fill="white"/></svg>',
        ),
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer();
  return sharp(background)
    .composite([{ input: rounded, left: 80, top: 256 }])
    .png()
    .toBuffer();
}

function validateWorkflow(workflow: Workflow): { duration: number; scenes: WorkflowScene[] } {
  const parsed = workflowSchema.safeParse(workflow);
  if (!parsed.success)
    throw new ApiError(400, 'RENDER_INVALID_WORKFLOW', 'The video workflow is not valid.');
  if (!workflow.script || !workflow.scenes)
    throw new ApiError(
      409,
      'RENDER_SCENES_REQUIRED',
      'Create a script and scene plan before rendering a video.',
    );
  if (!workflow.assets.length)
    throw new ApiError(
      409,
      'RENDER_IMAGES_REQUIRED',
      'Attach at least one product photo before rendering a video.',
    );
  if (
    workflow.approvals.brief !== workflow.contentRevision ||
    workflow.approvals.script !== workflow.script.id ||
    workflow.approvals.scenes !== workflow.scenes.id
  ) {
    throw new ApiError(
      409,
      'RENDER_APPROVAL_REQUIRED',
      'Approve the current brief, script, and scenes before rendering a video.',
    );
  }
  if (
    workflow.script.sourceRevision !== workflow.contentRevision ||
    workflow.scenes.sourceScriptId !== workflow.script.id
  ) {
    throw new ApiError(
      409,
      'RENDER_STALE_SCENES',
      'The scene plan must match the current approved script.',
    );
  }
  const duration = workflow.brief.duration;
  if (
    !duration ||
    workflow.scenes.scenes.reduce((sum, scene) => sum + scene.seconds, 0) !== duration ||
    workflow.script.segments.reduce((sum, segment) => sum + segment.seconds, 0) !== duration
  ) {
    throw new ApiError(
      400,
      'RENDER_TIMING_INVALID',
      'Script and scene timings must add up to the target video duration.',
    );
  }
  const segmentIds = new Set(workflow.script.segments.map((segment) => segment.id));
  const assetIds = new Set(workflow.assets.map((asset) => asset.id));
  if (
    workflow.scenes.scenes.some(
      (scene) =>
        !segmentIds.has(scene.scriptSegmentId) ||
        !scene.assetIds.length ||
        scene.assetIds.some((id) => !assetIds.has(id)),
    )
  ) {
    throw new ApiError(
      400,
      'RENDER_REFERENCE_INVALID',
      'Every scene must reference a current script segment and at least one photo attached to this workflow.',
    );
  }
  return { duration, scenes: workflow.scenes.scenes };
}

async function encode(
  executable: string,
  cwd: string,
  output: string,
  duration: number,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<void> {
  aborted(signal);
  const filter = `[0:v]fps=${FPS},format=yuv420p,zoompan=z='min(1.025,1+0.025*on/${duration * FPS - 1})':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}[moving];[1:v]fps=${FPS},format=yuva420p[fixed];[moving][fixed]overlay=0:0:format=yuv420:shortest=1,fade=t=in:st=0:d=0.25,fade=t=out:st=${duration - 0.25}:d=0.25[video]`;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-protocol_whitelist',
    'file,pipe',
    '-f',
    'concat',
    '-safe',
    '1',
    '-i',
    'frames.ffconcat',
    '-protocol_whitelist',
    'file,pipe',
    '-f',
    'concat',
    '-safe',
    '1',
    '-i',
    'overlays.ffconcat',
    '-filter_complex',
    filter,
    '-map',
    '[video]',
    '-t',
    String(duration),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '21',
    '-threads',
    '2',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-map_metadata',
    '-1',
    '-progress',
    'pipe:1',
    output,
  ];
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cancel = () => child.kill('SIGTERM');
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 5 * 60_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stderr.on('data', (data: Buffer) => {
      stderr = `${stderr}${data.toString('utf8')}`.slice(-8000);
    });
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
      const values = stdout.split('\n');
      stdout = values.pop() ?? '';
      for (const value of values) {
        const match = /^out_time_us=(\d+)/.exec(value);
        if (match)
          onProgress?.(0.25 + 0.7 * Math.min(1, Number(match[1]) / (duration * 1_000_000)));
      }
    });
    child.once('error', () =>
      finish(
        new ApiError(
          503,
          'RENDER_ENCODER_UNAVAILABLE',
          'The video encoder could not be started. Check the FFmpeg installation.',
        ),
      ),
    );
    child.once('close', (code) => {
      if (signal?.aborted)
        finish(new ApiError(409, 'RENDER_CANCELLED', 'The video render was cancelled.'));
      else if (timedOut)
        finish(
          new ApiError(
            504,
            'RENDER_TIMEOUT',
            'The video took too long to render. Try a shorter video or fewer scenes.',
          ),
        );
      else if (code !== 0)
        finish(
          new ApiError(
            500,
            'RENDER_ENCODING_FAILED',
            `The video could not be encoded.${stderr.includes('Unknown encoder') ? ' This FFmpeg build needs the libx264 encoder.' : ' Check that the encoder and temporary storage are available.'}`,
          ),
        );
      else finish();
    });
  });
}

/** Render only the supplied, approved photos and copy. This does not generate footage or audio. */
export async function renderPromoVideo(options: RenderOptions): Promise<RenderResult> {
  const { workflow, outputPath, loadAsset, signal, onProgress } = options;
  const { duration, scenes } = validateWorkflow(workflow);
  if (!isAbsolute(outputPath) || extname(outputPath).toLowerCase() !== '.mp4')
    throw new ApiError(400, 'RENDER_OUTPUT_INVALID', 'Use an absolute MP4 output path.');
  const outputParent = resolve(dirname(outputPath));
  let requestedWorkDirectory: string | undefined;
  if (options.workDirectory !== undefined) {
    requestedWorkDirectory = resolve(options.workDirectory);
    const withinParent = relative(outputParent, requestedWorkDirectory);
    if (
      !isAbsolute(options.workDirectory) ||
      !withinParent ||
      withinParent === '..' ||
      isAbsolute(withinParent) ||
      dirname(withinParent) !== '.' ||
      requestedWorkDirectory === parse(requestedWorkDirectory).root ||
      relative(resolve(outputPath), requestedWorkDirectory) === ''
    ) {
      throw new ApiError(
        400,
        'RENDER_WORKSPACE_INVALID',
        'Use a dedicated render workspace directly inside the video output directory.',
      );
    }
  }
  const executable = options.ffmpegPath ?? ffmpegStatic;
  if (!executable)
    throw new ApiError(
      503,
      'RENDER_ENCODER_UNAVAILABLE',
      'FFmpeg is not installed for this platform. Configure an encoder path.',
    );
  aborted(signal);
  let directory: string | undefined;
  let createdWorkDirectory = false;
  const images = new Map<string, Buffer>();
  let createdOutput = false;
  try {
    await mkdir(outputParent, { recursive: true });
    if (requestedWorkDirectory) {
      try {
        await mkdir(requestedWorkDirectory, { recursive: false });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
          throw new ApiError(
            409,
            'RENDER_WORKSPACE_EXISTS',
            'Another render already owns this workspace. Start a new render.',
          );
        }
        throw error;
      }
      directory = requestedWorkDirectory;
    } else {
      directory = await mkdtemp(join(outputParent, '.yap-render-'));
    }
    createdWorkDirectory = true;
    const temporaryOutput = join(directory, `output-${randomUUID()}.mp4`);
    const manifest = ['ffconcat version 1.0'];
    const overlayManifest = ['ffconcat version 1.0'];
    for (let index = 0; index < scenes.length; index += 1) {
      aborted(signal);
      const scene = scenes[index]!;
      const asset = workflow.assets.find((candidate) => candidate.id === scene.assetIds[0])!;
      let photo = images.get(asset.id);
      if (!photo) {
        photo = await loadAsset(asset);
        if (
          !Buffer.isBuffer(photo) ||
          !photo.length ||
          photo.length > MAX_ASSET_BYTES ||
          photo.length !== asset.bytes ||
          createHash('sha256').update(photo).digest('hex') !== asset.sha256
        ) {
          throw new ApiError(
            400,
            'RENDER_IMAGE_INTEGRITY',
            'An attached image no longer matches its saved metadata. Upload it again before rendering.',
          );
        }
        images.set(asset.id, photo);
      }
      const filename = `scene-${String(index).padStart(3, '0')}.png`;
      const overlayFilename = `overlay-${String(index).padStart(3, '0')}.png`;
      await writeFile(join(directory, filename), await photoFrame(photo), {
        flag: 'wx',
      });
      await writeFile(
        join(directory, overlayFilename),
        await sharp(overlay(workflow, scene, index))
          .png()
          .toBuffer(),
        { flag: 'wx' },
      );
      manifest.push(`file '${filename}'`, `duration ${scene.seconds}`);
      overlayManifest.push(`file '${overlayFilename}'`, `duration ${scene.seconds}`);
      onProgress?.((0.25 * (index + 1)) / scenes.length);
    }
    manifest.push(`file 'scene-${String(scenes.length - 1).padStart(3, '0')}.png'`);
    overlayManifest.push(`file 'overlay-${String(scenes.length - 1).padStart(3, '0')}.png'`);
    await writeFile(join(directory, 'frames.ffconcat'), `${manifest.join('\n')}\n`, 'utf8');
    await writeFile(
      join(directory, 'overlays.ffconcat'),
      `${overlayManifest.join('\n')}\n`,
      'utf8',
    );
    await encode(executable, directory, temporaryOutput, duration, signal, onProgress);
    aborted(signal);
    await copyFile(temporaryOutput, outputPath, constants.COPYFILE_EXCL);
    createdOutput = true;
    const outputStat = await stat(outputPath);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(outputPath)) hash.update(chunk);
    aborted(signal);
    if (!outputStat.size)
      throw new ApiError(500, 'RENDER_EMPTY_OUTPUT', 'The encoder did not produce a video.');
    onProgress?.(1);
    return {
      bytes: outputStat.size,
      sha256: hash.digest('hex'),
      width: WIDTH,
      height: HEIGHT,
      duration,
    };
  } catch (error) {
    if (createdOutput) await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    // Only remove a directory this invocation created, after resolving its allowed parent above.
    if (createdWorkDirectory && directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
