import { cp, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const source = resolve(repository, 'public');
const parent = resolve(repository, 'apps/web/public');
const output = resolve(parent, 'showcase');

if (!(await stat(resolve(source, 'index.html'))).isFile()) {
  throw new Error('The cinematic showcase is missing public/index.html.');
}

await mkdir(parent, { recursive: true });
const actualParent = await realpath(parent);
const parentRelative = relative(repository, actualParent);
if (
  parentRelative.startsWith('..') ||
  isAbsolute(parentRelative) ||
  relative(actualParent, output) !== 'showcase'
) {
  throw new Error('Showcase output must stay in apps/web/public/showcase.');
}

const existing = await lstat(output).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (existing) {
  if (existing.isSymbolicLink() || relative(actualParent, await realpath(output)) !== 'showcase') {
    throw new Error('Refusing to replace a redirected showcase output.');
  }
  await rm(output, { recursive: true, force: true });
}

await cp(source, output, { recursive: true });
console.log('Synced public/ into apps/web/public/showcase/.');
