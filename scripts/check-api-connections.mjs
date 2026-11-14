// Configuration readiness only: these GETs never submit generation or research.
const args = process.argv.slice(2);
const json = args.includes('--json');
const address = args.find((arg) => arg.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:3001';
const base = new URL(address);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
  throw new Error('Use the API origin without credentials.');
const endpoints = {
  health: '/api/health',
  creator: '/api/creator/capabilities',
  budget: '/api/creator/budget',
  research: '/api/social/providers',
};
const checks = await Promise.all(
  Object.entries(endpoints).map(async ([name, path]) => {
    try {
      const response = await fetch(new URL(path, base), {
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (!response.ok) return [name, { error: `HTTP ${response.status}` }];
      return [name, await response.json()];
    } catch {
      return [name, { error: 'API unavailable. Start npm run dev, then retry.' }];
    }
  }),
);
const result = Object.fromEntries(checks);
const creator = result.creator;
const ready = Boolean(creator.configured && creator.visionConfigured && !result.budget.error);
const report = {
  api: base.origin,
  readyForLiveValidation: ready,
  caveat:
    'Configuration presence only; API keys, entitlement, balance and paid generation are not validated.',
  ...result,
};
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`API: ${base.origin}`);
  console.log(
    `Video: ${creator.configured ? 'key configured' : 'missing key'} (${creator.provider ?? 'unknown'} / ${creator.model ?? 'unknown'})`,
  );
  console.log(`Visual review: ${creator.visionConfigured ? 'key configured' : 'missing key'}`);
  console.log(
    `Research: ${creator.researchConfigured ? 'key configured' : 'no live discovery key'}`,
  );
  if (result.budget.budget) {
    const budget = result.budget.budget;
    console.log(
      `App budget: $${(budget.availableCents / 100).toFixed(2)} available of $${(budget.limitCents / 100).toFixed(2)}`,
    );
  }
  for (const [name, value] of checks) if (value.error) console.log(`${name}: ${value.error}`);
  console.log(report.caveat);
}
if (checks.some(([, value]) => value.error)) process.exitCode = 1;
