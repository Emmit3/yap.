import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, copyFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp, { type OutputInfo } from 'sharp';
import { z } from 'zod';
import {
  brandInputSchema,
  brandSettingsSchema,
  brandSnapshotSchema,
  brandUpdateSchema,
  brandLogoSchema,
  type BrandSettings,
  type BrandSnapshot,
  type BrandLogo,
} from '@yap/contracts/production';
import { ApiError } from './errors.js';
import {
  productionTextAss,
  productionTextEmWidth,
  type ProductionTextLayer,
} from './creator-production-text.js';
import {
  productionStore,
  verifyProductionFile,
  runProductionFfmpeg,
  productionMovieReceipt,
  type ProductionMovieMetadata,
} from './creator-production-storage.js';

const defaults: BrandSettings = {
  version: 0,
  updatedAt: '1970-01-01T00:00:00.000Z',
  name: '',
  font: 'sans',
  inkColor: '#171717',
  paperColor: '#ffffff',
  accentColor: '#70513d',
  logo: null,
  endCard: { enabled: false, title: '', detail: '', seconds: 2 },
};
const hashBrand = (brand: BrandSettings) =>
  createHash('sha256')
    .update(JSON.stringify(brandSettingsSchema.parse(brand)))
    .digest('hex');
const assertVersion = (brand: BrandSettings, expected: number) => {
  if (brand.version !== expected)
    throw new ApiError(
      409,
      'CREATOR_BRAND_VERSION_CONFLICT',
      'Brand settings changed. Reload them before saving your edits.',
    );
};
export async function createBrandService(directory: string) {
  const root = resolve(directory),
    logos = join(root, 'brand-logos');
  const store = await productionStore(
    join(root, 'creator-brand.json'),
    z
      .object({
        schemaVersion: z.literal(1),
        settings: brandSettingsSchema,
        logos: z.array(brandLogoSchema).max(64),
      })
      .strict(),
    { schemaVersion: 1 as const, settings: defaults, logos: [] },
  );
  const logoPath = (logo: BrandLogo) => join(logos, `${brandLogoSchema.parse(logo).sha256}.png`);
  return {
    async get(): Promise<BrandSettings> {
      return (await store.read()).settings;
    },
    async update(input: z.input<typeof brandUpdateSchema>): Promise<BrandSettings> {
      const value = brandUpdateSchema.parse(input);
      return store.mutate((next) => {
        assertVersion(next.settings, value.expectedVersion);
        next.settings = {
          ...brandInputSchema.parse(value.brand),
          version: next.settings.version + 1,
          updatedAt: new Date().toISOString(),
          logo: next.settings.logo,
        };
        return next.settings;
      });
    },
    async uploadLogo(input: { expectedVersion: number; bytes: Buffer }): Promise<BrandSettings> {
      if (
        !Buffer.isBuffer(input.bytes) ||
        input.bytes.length < 1 ||
        input.bytes.length > 8 * 1024 * 1024
      )
        throw new ApiError(
          413,
          'CREATOR_BRAND_LOGO_SIZE',
          'Choose a PNG, JPEG or WebP logo smaller than 8 MiB.',
        );
      const magic = input.bytes;
      if (!(
        magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        (magic[0] === 255 && magic[1] === 216 && magic[2] === 255) ||
        (magic.toString('ascii', 0, 4) === 'RIFF' && magic.toString('ascii', 8, 12) === 'WEBP')
      ))
        throw new ApiError(
          422,
          'CREATOR_BRAND_LOGO_INVALID',
          'Use an actual PNG, JPEG or WebP image for the logo.',
        );
      let normalized: Buffer, info: OutputInfo;
      try {
        const image = sharp(input.bytes, { limitInputPixels: 20_000_000, failOn: 'error' });
        const metadata = await image.metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
          throw new Error('Unsupported image.');
        const result = await image
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer({ resolveWithObject: true });
        normalized = result.data;
        info = result.info;
      } catch {
        throw new ApiError(
          422,
          'CREATOR_BRAND_LOGO_INVALID',
          'The logo could not be decoded. Use a single PNG, JPEG or WebP image.',
        );
      }
      const receipt = brandLogoSchema.parse({
        mimeType: 'image/png',
        bytes: normalized.length,
        sha256: createHash('sha256').update(normalized).digest('hex'),
        width: info.width,
        height: info.height,
      });
      return store.mutate(async (next) => {
        assertVersion(next.settings, input.expectedVersion);
        if (!next.logos.some((logo) => logo.sha256 === receipt.sha256)) {
          if (next.logos.length >= 64)
            throw new ApiError(
              409,
              'CREATOR_BRAND_LOGO_LIMIT',
              'The workspace logo library is full. Existing approved films keep their saved logos.',
            );
          await mkdir(logos, { recursive: true });
          const temporary = join(logos, `${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, normalized, { flag: 'wx' });
            await rename(temporary, logoPath(receipt));
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
          next.logos.push(receipt);
        } else await verifyProductionFile(logoPath(receipt), receipt);
        next.settings = {
          ...next.settings,
          logo: receipt,
          version: next.settings.version + 1,
          updatedAt: new Date().toISOString(),
        };
        return next.settings;
      });
    },
    async clearLogo(input: { expectedVersion: number }): Promise<BrandSettings> {
      return store.mutate((next) => {
        assertVersion(next.settings, input.expectedVersion);
        next.settings = {
          ...next.settings,
          logo: null,
          version: next.settings.version + 1,
          updatedAt: new Date().toISOString(),
        };
        return next.settings;
      });
    },
    async snapshot(): Promise<BrandSnapshot> {
      const settings = (await store.read()).settings;
      if (settings.logo) await verifyProductionFile(logoPath(settings.logo), settings.logo);
      return { ...settings, sha256: hashBrand(settings) };
    },
    async verifySnapshot(input: BrandSnapshot): Promise<BrandSnapshot> {
      const snapshot = brandSnapshotSchema.parse(input),
        { sha256, ...settings } = snapshot;
      if (hashBrand(settings) !== sha256)
        throw new ApiError(
          409,
          'CREATOR_BRAND_STALE',
          'The saved brand snapshot changed. Apply the brand again before approval.',
        );
      if (settings.logo) await verifyProductionFile(logoPath(settings.logo), settings.logo);
      return snapshot;
    },
    logoPath,
  };
}

const fonts =
  process.platform === 'win32'
    ? { sans: 'Arial', serif: 'Georgia', mono: 'Consolas' }
    : process.platform === 'darwin'
      ? { sans: 'Arial', serif: 'Georgia', mono: 'Menlo' }
      : { sans: 'DejaVu Sans', serif: 'DejaVu Serif', mono: 'DejaVu Sans Mono' };
export const productionFontName = (font: BrandSettings['font']) => fonts[font];
export async function prepareProductionFont(
  directory: string,
  font: BrandSettings['font'] = 'sans',
): Promise<string> {
  const windows = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts');
  const candidates =
    process.platform === 'win32'
      ? [join(windows, { sans: 'arial.ttf', serif: 'georgia.ttf', mono: 'consola.ttf' }[font])]
      : process.platform === 'darwin'
        ? [
            join(
              '/System/Library/Fonts/Supplemental',
              { sans: 'Arial.ttf', serif: 'Georgia.ttf', mono: 'Courier New.ttf' }[font],
            ),
            ...(font === 'mono' ? ['/System/Library/Fonts/Menlo.ttc'] : []),
          ]
        : [
            join(
              '/usr/share/fonts/truetype/dejavu',
              { sans: 'DejaVuSans.ttf', serif: 'DejaVuSerif.ttf', mono: 'DejaVuSansMono.ttf' }[
                font
              ],
            ),
            join(
              '/usr/share/fonts/dejavu',
              { sans: 'DejaVuSans.ttf', serif: 'DejaVuSerif.ttf', mono: 'DejaVuSansMono.ttf' }[
                font
              ],
            ),
          ];
  for (const source of candidates) {
    try {
      await access(source);
      await copyFile(source, join(directory, 'brand-font.ttf'));
      return 'brand-font.ttf';
    } catch {
      /* Try the next system font location. */
    }
  }
  throw new ApiError(
    503,
    'CREATOR_BRAND_FONT_UNAVAILABLE',
    'The chosen film font is unavailable on this server. Install its system fonts or choose another typeface.',
  );
}
const assColor = (color: string) =>
  `&H00${color.slice(5, 7)}${color.slice(3, 5)}${color.slice(1, 3)}`.toUpperCase();
export function subtitleStyle(brand: BrandSnapshot) {
  const value = brandSnapshotSchema.parse(brand);
  return {
    fontName: fonts[value.font],
    fontSize: 54,
    primaryColor: assColor(value.inkColor),
    outlineColor: assColor(value.paperColor),
    outline: 3,
  };
}
export function wrapProductionText(text: string, maxEm: number): string {
  const advance = productionTextEmWidth;
  const words = text.replace(/\s+/gu, ' ').trim().split(' '),
    lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (advance(word) > maxEm) {
      if (line) lines.push(line);
      line = '';
      for (const character of word) {
        if (advance(line + character) > maxEm) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    } else if (line && advance(`${line} ${word}`) > maxEm) {
      lines.push(line);
      line = word;
    } else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
/** Applies only an explicitly approved immutable brand snapshot; duration and audio are retained. */
export async function renderBrandMovie(input: {
  input: string;
  output: string;
  directory: string;
  brand: BrandSnapshot;
  logoPath?: string;
  signal: AbortSignal;
  metadata: ProductionMovieMetadata;
}) {
  const brand = brandSnapshotSchema.parse(input.brand),
    directory = resolve(input.directory),
    metadata = input.metadata;
  if (brand.endCard.enabled && (brand.endCard.seconds >= metadata.duration || !brand.endCard.title))
    throw new ApiError(
      422,
      'CREATOR_BRAND_END_CARD',
      'Give the end card a title and keep it shorter than the film.',
    );
  if (brand.logo && !input.logoPath)
    throw new ApiError(
      409,
      'CREATOR_BRAND_LOGO_MISSING',
      'The approved logo is unavailable. Apply brand settings again.',
    );
  if (brand.logo && input.logoPath) await verifyProductionFile(input.logoPath, brand.logo);
  await mkdir(directory, { recursive: true });
  await prepareProductionFont(directory, brand.font);
  const scale = Math.min(metadata.width / 1080, metadata.height / 1920),
    size = (value: number) => Math.max(1, Math.round(value * scale));
  const paper = `0x${brand.paperColor.slice(1)}`,
    accent = `0x${brand.accentColor.slice(1)}`;
  const filters: string[] = [],
    args = ['-protocol_whitelist', 'file,pipe', '-i', resolve(input.input)];
  if (brand.logo) {
    args.push('-i', resolve(input.logoPath!));
    filters.push(`[1:v]scale=${size(144)}:${size(144)}:force_original_aspect_ratio=decrease[logo]`);
  }
  filters.push('[0:v]null[marked]');
  const draw: string[] = [`drawbox=x=0:y=0:w=iw:h=${size(8)}:color=${accent}:t=fill`],
    text: ProductionTextLayer[] = [],
    fontName = productionFontName(brand.font),
    endCardStart = metadata.duration - brand.endCard.seconds;
  if (brand.name) {
    text.push({
      text: wrapProductionText(
        brand.name,
        (metadata.width - size(brand.logo ? 352 : 192)) / size(32),
      ),
      start: 0,
      end: brand.endCard.enabled ? endCardStart : metadata.duration,
      x: size(brand.logo ? 256 : 96),
      y: size(104),
      fontName,
      fontSize: size(32),
      color: brand.inkColor,
      alignment: 'top-left',
      box: { color: brand.paperColor, opacity: 0.9, padding: size(12) },
    });
  }
  if (brand.endCard.enabled) {
    const when = `gte(t,${endCardStart.toFixed(3)})`;
    draw.push(
      `drawbox=x=0:y=0:w=iw:h=ih:color=${paper}:t=fill:enable='${when}'`,
      `drawbox=x=${size(96)}:y=ih*0.28:w=${size(96)}:h=${size(8)}:color=${accent}:t=fill:enable='${when}'`,
    );
    text.push({
      text: wrapProductionText(brand.endCard.title, (metadata.width - size(192)) / size(48)),
      start: endCardStart,
      end: metadata.duration,
      x: size(96),
      y: metadata.height * 0.34,
      fontName,
      fontSize: size(48),
      color: brand.inkColor,
      alignment: 'top-left',
    });
    if (brand.endCard.detail)
      text.push({
        text: wrapProductionText(brand.endCard.detail, (metadata.width - size(192)) / size(28)),
        start: endCardStart,
        end: metadata.duration,
        x: size(96),
        y: metadata.height * 0.67,
        fontName,
        fontSize: size(28),
        color: brand.inkColor,
        alignment: 'top-left',
      });
  }
  if (text.length) {
    await writeFile(
      join(directory, 'brand-text.ass'),
      productionTextAss(metadata.width, metadata.height, text),
      'utf8',
    );
    draw.push('ass=filename=brand-text.ass:fontsdir=.');
  }
  filters.push(`[marked]${draw.join(',')}[${brand.logo ? 'drawn' : 'video'}]`);
  if (brand.logo) filters.push(`[drawn][logo]overlay=${size(80)}:${size(80)}:format=auto[video]`);
  await runProductionFfmpeg(
    [
      ...args,
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[video]',
      '-map',
      '0:a?',
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
      '-c:a',
      'copy',
      '-t',
      String(metadata.duration),
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      '-y',
      resolve(input.output),
    ],
    input.signal,
    directory,
  );
  return productionMovieReceipt(resolve(input.output), metadata, input.signal, directory);
}
