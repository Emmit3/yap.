// Saves and restores the local API data directory so a finished film can be shown
// instantly if a provider is slow or fails during a live demo.
//
//   npm run demo:snapshot -- save [name]
//   npm run demo:snapshot -- restore [name] [--allow-budget-rewind]
//   npm run demo:snapshot -- list
//
// Stop the API before `restore`. The data directory holds the spending ledger, so
// restoring an older snapshot would forget spending recorded after it was saved;
// that is refused unless --allow-budget-rewind is given.
import { cp, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class SnapshotError extends Error {}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Finished films and recorded spending in a data directory. */
export async function inspect(directory) {
  let state;
  try {
    state = JSON.parse(await readFile(join(directory, 'creator-sessions.json'), 'utf8'));
  } catch {
    return { films: [], spentCents: 0 };
  }
  const films = [];
  for (const job of state.jobs ?? []) {
    if (job.kind !== 'production' || job.status !== 'succeeded' || !job.output) continue;
    if (!(await exists(join(directory, 'creator-videos', `${job.id}.mp4`)))) continue;
    films.push({
      sessionId: job.sessionId,
      jobId: job.id,
      seconds: job.output.duration,
      hasAudio: job.output.hasAudio === true,
    });
  }
  const spentCents = (state.budget?.reservations ?? []).reduce(
    (sum, item) => sum + (item.chargedCents ?? item.amountCents),
    0,
  );
  return { films, spentCents };
}

function snapshotPath(snapshots, name) {
  if (!NAME.test(name))
    throw new SnapshotError('Use a short name of lowercase letters, digits and hyphens.');
  return join(snapshots, name);
}

export async function save({ data, snapshots, name, force = false }) {
  const target = snapshotPath(snapshots, name);
  if (!(await exists(data))) throw new SnapshotError(`No data directory at ${data}.`);
  const summary = await inspect(data);
  if (summary.films.length === 0 && !force)
    throw new SnapshotError(
      'No finished film was found, so this snapshot would not help in a demo. Finish a film first, or pass --force.',
    );
  if (await exists(target))
    throw new SnapshotError(`A snapshot named "${name}" already exists. Choose another name.`);
  await mkdir(snapshots, { recursive: true });
  await cp(data, target, { recursive: true, errorOnExist: true, force: false });
  return summary;
}

export async function restore({
  data,
  snapshots,
  name,
  allowBudgetRewind = false,
  now = new Date(),
}) {
  const source = snapshotPath(snapshots, name);
  if (!(await exists(source))) throw new SnapshotError(`No snapshot named "${name}".`);
  const [saved, current] = [await inspect(source), await inspect(data)];
  if (current.spentCents > saved.spentCents && !allowBudgetRewind)
    throw new SnapshotError(
      `The current data records more spending (${current.spentCents} cents) than this snapshot (${saved.spentCents} cents). Restoring would forget it. Pass --allow-budget-rewind only if you accept that.`,
    );
  let replaced = null;
  if (await exists(data)) {
    replaced = join(snapshots, `_replaced-${now.toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(snapshots, { recursive: true });
    await rename(data, replaced);
  }
  await cp(source, data, { recursive: true });
  return { ...saved, replaced };
}

export async function list(snapshots) {
  if (!(await exists(snapshots))) return [];
  const names = (await readdir(snapshots, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    names.map(async (name) => ({ name, ...(await inspect(join(snapshots, name))) })),
  );
}

async function apiRunning(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/creator/budget`, {
      signal: AbortSignal.timeout(1500),
    });
    return true;
  } catch {
    return false;
  }
}

const describe = (films) =>
  films.length === 0
    ? '  no finished films'
    : films
        .map(
          (film) =>
            `  http://127.0.0.1:5173/#/create/${film.sessionId}  (${film.seconds}s, ${film.hasAudio ? 'with sound' : 'silent'})`,
        )
        .join('\n');

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((value) => value.startsWith('--')));
  const name = rest.find((value) => !value.startsWith('--')) ?? 'demo';
  const data = resolve(
    process.env.API_DATA_FILE ? dirname(process.env.API_DATA_FILE) : join(root, 'apps/api/data'),
  );
  const snapshots = join(root, 'artifacts/demo-snapshots');
  if (command === 'save') {
    const summary = await save({ data, snapshots, name, force: flags.has('--force') });
    console.log(`Saved snapshot "${name}" with ${summary.films.length} finished film(s):`);
    console.log(describe(summary.films));
  } else if (command === 'restore') {
    if (await apiRunning(Number(process.env.PORT ?? 3001)))
      throw new SnapshotError('Stop the API (Ctrl+C on npm run dev) before restoring.');
    const summary = await restore({
      data,
      snapshots,
      name,
      allowBudgetRewind: flags.has('--allow-budget-rewind'),
    });
    console.log(`Restored snapshot "${name}". Start the app with npm run dev, then open:`);
    console.log(describe(summary.films));
    if (summary.replaced) console.log(`The data it replaced was kept at ${summary.replaced}`);
  } else if (command === 'list') {
    const all = await list(snapshots);
    if (all.length === 0) console.log('No snapshots saved yet.');
    for (const item of all) console.log(`${item.name}\n${describe(item.films)}`);
  } else {
    throw new SnapshotError('Usage: npm run demo:snapshot -- save|restore|list [name]');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((error) => {
    console.error(error instanceof SnapshotError ? error.message : error);
    process.exit(1);
  });
