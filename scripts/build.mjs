import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Build the workspace with npm run build.');
for (const [workspace, path] of [
  ['@yap/contracts', 'packages/contracts/package.json'],
  ['@yap/api', 'apps/api/package.json'],
  ['@yap/web', 'apps/web/package.json'],
]) {
  if (!existsSync(path)) continue;
  const result = spawnSync(process.execPath, [npmCli, 'run', 'build', `--workspace=${workspace}`], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
