import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('dist');
const workspace = resolve('.');
if (!output.startsWith(workspace + '/') && !output.startsWith(workspace + '\\'))
  throw new Error('Build output must be within workspace');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve('public'), output, { recursive: true });
console.log(`Built ${(await readdir(output)).length} entries to dist/`);
