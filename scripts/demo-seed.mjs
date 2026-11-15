import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCreatorSessionSchema, creatorSessionResponseSchema } from '@yap/contracts/creator';
import { workflowResponseSchema } from '@yap/contracts/workflow';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const demoLabel = 'Mori Drinks — fictional demo';
export const demoInput = createCreatorSessionSchema.parse({
  input: {
    mode: 'media',
    platform: 'instagram',
    duration: 15,
    tone: 'conversational',
    urls: [],
    prompt: `${demoLabel}\nCreate a 15-second vertical film for a fictional independent drinks shop. Show an iced matcha break and the care behind a good coffee. Audience: people looking for a calm afternoon pause. Message: a small daily ritual, made with care. End with “Make time for a little Mori.” Use a close-up opening, one preparation moment, and a quiet final product shot. No prices, opening hours, address, health claims or customer testimonials. These supplied photos are illustrative licensed stock, not photographs of a real Mori Drinks business. Ask before inventing any other business facts.`,
  },
});
const photoFiles = ['product-matcha.jpg', 'product-espresso.jpg'];

export function localOrigin(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use a loopback origin such as http://127.0.0.1:3001.');
  return url.origin;
}

async function photos(directory) {
  const credits = JSON.parse(await readFile(join(directory, 'credits.json'), 'utf8'));
  return Promise.all(
    photoFiles.map(async (file) => {
      const credit = credits.images.find((image) => image.file === file);
      const bytes = await readFile(join(directory, file));
      if (
        credit?.illustrative !== true ||
        credit.generatedByYap !== false ||
        ![credit.title, credit.creator].every(
          (value) => typeof value === 'string' && value.trim(),
        ) ||
        credit.source !== 'Unsplash' ||
        credit.license !== 'Unsplash License' ||
        !/^https:\/\/unsplash\.com\/photos\//.test(credit.sourcePage ?? '') ||
        createHash('sha256').update(bytes).digest('hex') !== credit.sha256
      )
        throw new Error(`The credited demo photo ${file} is missing or has changed.`);
      return { file, bytes, credit };
    }),
  );
}

/** Seeds only the creator intake and supplied photos. Never analyzes, quotes or approves. */
export async function seedDemo({
  apiOrigin = 'http://127.0.0.1:3001',
  webOrigin = 'http://127.0.0.1:5173',
  manifestFile = join(root, 'artifacts/demo-seed/mori.json'),
  mediaDirectory = join(root, 'public/media'),
  fresh = false,
  transport = fetch,
} = {}) {
  const api = localOrigin(apiOrigin),
    web = localOrigin(webOrigin);
  const supplied = await photos(mediaDirectory);
  await mkdir(dirname(manifestFile), { recursive: true });
  let lock;
  try {
    lock = await open(`${manifestFile}.lock`, 'wx');
  } catch {
    throw new Error(
      'Another seed may be running. Check it before removing artifacts/demo-seed/mori.json.lock.',
    );
  }
  try {
    const request = async (path, schema, init) => {
      const response = await transport(api + path, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const value = await response.json().catch(() => {
        throw new Error(
          `The API returned an unreadable response (${response.status}). Check --api.`,
        );
      });
      if (!response.ok)
        throw new Error(value?.error?.message ?? `Demo request failed (${response.status}).`);
      return schema.parse(value);
    };
    const json = (method, body) => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let pointer;
    try {
      pointer = JSON.parse(await readFile(manifestFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(
          'The demo pointer cannot be read. Keep it for recovery and use a different manifest file.',
        );
    }
    if (pointer && fresh) {
      await writeFile(
        `${manifestFile}.${Date.now()}.previous.json`,
        JSON.stringify(pointer, null, 2),
        { flag: 'wx' },
      );
      pointer = undefined;
    }
    const persist = async () => {
      await writeFile(`${manifestFile}.tmp`, JSON.stringify(pointer, null, 2) + '\n');
      await rename(`${manifestFile}.tmp`, manifestFile);
    };
    let saved;
    if (pointer) {
      if (
        pointer.version !== 1 ||
        pointer.apiOrigin !== api ||
        !/^[a-f0-9-]{36}$/i.test(pointer.sessionId) ||
        !/^[a-f0-9-]{36}$/i.test(pointer.workflowId) ||
        typeof pointer.ready !== 'boolean'
      )
        throw new Error(
          'The saved demo pointer does not match this API. Use --new to create a separate fixture.',
        );
      saved = await request(
        `/api/creator/sessions/${pointer.sessionId}`,
        creatorSessionResponseSchema,
      );
      if (
        saved.workflow.id !== pointer.workflowId ||
        !saved.session.input.prompt.startsWith(demoLabel)
      )
        throw new Error(
          'This saved record no longer identifies the demo fixture. It was preserved; use --new.',
        );
      if (pointer.ready)
        return { ...pointer, url: `${web}/#/create/${pointer.sessionId}`, reused: true };
    } else {
      saved = await request(
        '/api/creator/sessions',
        creatorSessionResponseSchema,
        json('POST', demoInput),
      );
      pointer = {
        version: 1,
        apiOrigin: api,
        sessionId: saved.session.id,
        workflowId: saved.workflow.id,
        createdAt: new Date().toISOString(),
        ready: false,
      };
      await persist();
    }
    let workflow = saved.workflow;
    for (const { file, bytes, credit } of supplied) {
      let added = workflow.assets.find((asset) => asset.sha256 === credit.sha256);
      if (!added) {
        workflow = (
          await request(
            `/api/workflows/${workflow.id}/assets?expectedVersion=${workflow.version}`,
            workflowResponseSchema,
            {
              method: 'POST',
              headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent(file) },
              body: bytes,
            },
          )
        ).workflow;
        added = workflow.assets.find((asset) => asset.sha256 === credit.sha256);
      }
      if (!added)
        throw new Error('The uploaded photo was not returned. Rerun to resume the saved fixture.');
      if (!added.description.trim())
        workflow = (
          await request(
            `/api/workflows/${workflow.id}/assets/${added.id}`,
            workflowResponseSchema,
            json('PATCH', {
              expectedVersion: workflow.version,
              description: `Illustrative licensed stock for the fictional Mori Drinks demo: ${credit.title}. Photo by ${credit.creator}, ${credit.source}; ${credit.license}. Not a real Mori Drinks location or Yap-generated image.`,
            }),
          )
        ).workflow;
    }
    pointer.ready = true;
    pointer.photos = supplied.map(({ file, credit }) => ({
      file,
      sha256: credit.sha256,
      creator: credit.creator,
      sourcePage: credit.sourcePage,
      license: credit.license,
    }));
    await persist();
    return { ...pointer, url: `${web}/#/create/${pointer.sessionId}`, reused: false };
  } finally {
    await lock.close();
    await unlink(`${manifestFile}.lock`);
  }
}

async function main() {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--new') options.fresh = true;
    else if (['--api', '--web'].includes(args[i]) && args[i + 1])
      options[args[i++] === '--api' ? 'apiOrigin' : 'webOrigin'] = args[i];
    else
      throw new Error(
        'Usage: npm run demo:seed -- [--api http://127.0.0.1:3001] [--web http://127.0.0.1:5173] [--new]',
      );
  }
  const result = await seedDemo(options);
  console.log(
    `${result.reused ? 'Reopened' : 'Prepared'} ${demoLabel}:\n${result.url}\n${result.reused ? 'Existing fixture reused; your saved edits and media were preserved.' : 'Idea and two attributed illustrative photos saved.'} Research, script preparation and paid production have not been started by this command.`,
  );
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
