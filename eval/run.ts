/**
 * False-positive check: replays the last few stable releases of popular
 * packages (assumed benign) and counts how often bumpvet would speak up.
 * Each update is vetted as the CLI vets it.
 *
 * Each update is vetted twice: one hour after publish (a Dependabot-style
 * PR opened right away) and seven days after (a team that waits).
 *
 * It downloads every packument, and the tarball of every new version: run it
 * in the Evaluate false positives workflow (CONTRIBUTING.md, Evaluation).
 *
 *   npm run eval [-- --per-package 10] [--baseline 5]
 */
import { tarballFetcher } from '../src/tarball.js';
import type { Packument } from '../src/types/registry.js';
import { SIGNALS, type SignalId } from '../src/types/signals.js';
import type { PackageResult, Verdict } from '../src/types/verdicts.js';
import { messageOf } from '../src/utils/errors.js';
import { vetChanges } from '../src/vet.js';
import { PACKAGES, arg, load, pool, updates } from './updates.js';

const baselineSize = arg('--baseline');
const DELAYS = [
  { label: '1h after publish', hours: 1 },
  { label: '7d after publish', hours: 24 * 7 },
];

interface Row {
  update: string;
  delay: string;
  verdict: Verdict;
  signals: SignalId[];
  /** What the tamper signals said, which no benign update should have. */
  tamper: string[];
}

/** Packages and updates not measured (the registry or a download failed), with why. */
const failed = new Map<string, string>();
const packuments = new Map<string, Packument>();
await pool(PACKAGES, 8, async (name) => {
  try {
    packuments.set(name, await load(name));
  } catch (err) {
    failed.set(name, messageOf(err));
  }
});
const fetchPackument = (name: string) => Promise.resolve(packuments.get(name) ?? null);
/**
 * The bytes received of each tarball read, by URL, to show what the download
 * limit has to fit; counted as they arrive, since a response need not give
 * its length.
 */
const tarballBytes = new Map<string, number>();
const fetchTarball = tarballFetcher((async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  if (!res.body) return res;
  let bytes = 0;
  const counted = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        tarballBytes.set(url, bytes);
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}) as typeof fetch);

const tasks = [...packuments].flatMap(([name, p]) =>
  updates(p).flatMap(({ from, to }) =>
    DELAYS.map((d) => ({
      change: { name, from, to },
      delay: d.label,
      now: new Date(Date.parse(p.time[to]!) + d.hours * 3_600_000),
    })),
  ),
);
const rows: Row[] = [];
await pool(tasks, 8, async (t) => {
  const update = `${t.change.name} ${t.change.from} -> ${t.change.to}`;
  let result: PackageResult;
  try {
    // One change in, one result out.
    result = (
      await vetChanges([t.change], fetchPackument, fetchTarball, { now: t.now, baselineSize })
    )[0]!;
  } catch (err) {
    failed.set(update, messageOf(err));
    return;
  }
  rows.push({
    update,
    delay: t.delay,
    verdict: result.verdict,
    signals: result.signals.map((s) => s.id),
    tamper: result.signals
      .filter((s) => s.group === 'tamper')
      .map((s) => `${s.id}: ${s.before} -> ${s.after}`),
  });
});
rows.sort((a, b) => a.update.localeCompare(b.update));
// An update is measured only when both delays were: the two lines compare the same updates.
const measured = rows.filter((r) => !failed.has(r.update));

const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(1)}%`;
for (const d of DELAYS) {
  const set = measured.filter((r) => r.delay === d.label);
  const n = set.length;
  console.log(`\n== ${d.label}: ${n} updates of ${packuments.size} packages`);
  for (const v of ['ok', 'review', 'block'] as const) {
    const c = set.filter((r) => r.verdict === v).length;
    console.log(`  ${v.padEnd(7)} ${String(c).padStart(4)}  ${pct(c, n)}`);
  }
  // Every signal, so one that never fired reads as 0.
  console.log('  signals fired:');
  for (const s of Object.keys(SIGNALS) as SignalId[]) {
    const c = set.filter((r) => r.signals.includes(s)).length;
    console.log(`    ${s.padEnd(20)} ${String(c).padStart(4)}  ${pct(c, n)}`);
  }
}

for (const d of DELAYS) {
  const flagged = measured.filter((r) => r.delay === d.label && r.verdict !== 'ok');
  console.log(`\n== non-OK at ${d.label} (${flagged.length})`);
  for (const r of flagged) {
    console.log(`  ${r.verdict.padEnd(6)} ${r.update}  [${r.signals.join(', ')}]`);
    for (const t of r.tamper) console.log(`         ${t}`);
  }
}

const sizes = [...tarballBytes].sort((a, b) => b[1] - a[1]);
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
console.log(
  `\n== tarballs read: ${sizes.length}, ${mb(sizes.reduce((sum, [, b]) => sum + b, 0))} in all`,
);
for (const [url, bytes] of sizes.slice(0, 5)) console.log(`  ${mb(bytes).padStart(9)}  ${url}`);

if (failed.size) {
  console.log(`\n== not measured (${failed.size})`);
  for (const [update, why] of [...failed].sort()) console.log(`  ${update}  ${why}`);
}
