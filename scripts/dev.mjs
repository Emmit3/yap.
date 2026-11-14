import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Start the workspace with npm run dev.');
const options = { stdio: 'inherit' };
const build = spawnSync(
  process.execPath,
  [npmCli, 'run', 'build', '--workspace=@yap/contracts'],
  options,
);
if (build.status !== 0) process.exit(build.status ?? 1);

const workspaces = ['@yap/api'];
if (existsSync('apps/web/package.json')) workspaces.push('@yap/web');
const children = workspaces.map((workspace) =>
  spawn(process.execPath, [npmCli, 'run', 'dev', `--workspace=${workspace}`], options),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else child.kill('SIGTERM');
  }
  process.exit(code);
}
for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
