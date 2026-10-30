/**
 * False-positive check: replays the last few stable releases of popular
 * packages (assumed benign) and counts how often bumpvet would speak up.
 * Each update is vetted as the CLI vets it, reading the files of the releases
 * from the registry.
 *
 * Each update is vetted twice: one hour after publish (a Dependabot-style
 * PR opened right away) and seven days after (a team that waits).
 *
 * It downloads every packument and hundreds of tarballs: run it in the
 * Evaluate false positives workflow (CONTRIBUTING.md, Evaluation).
 *
 *   npm run eval [-- --per-package 10] [--baseline 5]
 */
import { registryContent } from '../src/content.js';
import type { Packument } from '../src/types/registry.js';
import type { SignalId } from '../src/types/signals.js';
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
  /** Why files were not read, for `content-not-checked` and `previous-not-checked`. */
  unread: string[];
}

// One reader for the run, so each tarball is downloaded once for both delays.
const readContent = registryContent();
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
// The reader limits how many tarballs are downloaded at once.
await pool(tasks, 8, async (t) => {
  const update = `${t.change.name} ${t.change.from} -> ${t.change.to}`;
  let result: PackageResult;
  try {
    // One change in, one result out.
    result = (
      await vetChanges([t.change], fetchPackument, readContent, { now: t.now, baselineSize })
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
    unread: result.signals
      .filter((s) => s.id === 'content-not-checked' || s.id === 'previous-not-checked')
      .map((s) => `${s.id}: ${s.id === 'content-not-checked' ? s.after : s.before}`),
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
  const bySignal = new Map<string, number>();
  for (const r of set) for (const s of r.signals) bySignal.set(s, (bySignal.get(s) ?? 0) + 1);
  console.log('  signals fired:');
  for (const [s, c] of [...bySignal].sort((a, b) => b[1] - a[1]))
    console.log(`    ${s.padEnd(20)} ${String(c).padStart(4)}  ${pct(c, n)}`);
}

for (const d of DELAYS) {
  const flagged = measured.filter((r) => r.delay === d.label && r.verdict !== 'ok');
  console.log(`\n== non-OK at ${d.label} (${flagged.length})`);
  for (const r of flagged)
    console.log(`  ${r.verdict.padEnd(6)} ${r.update}  [${r.signals.join(', ')}]`);
}

const unread = measured.filter((r) => r.delay === DELAYS[1]!.label && r.unread.length);
console.log(`\n== files not read (${unread.length})`);
for (const r of unread) console.log(`  ${r.update}  ${r.unread.join('; ')}`);

if (failed.size) {
  console.log(`\n== not measured (${failed.size})`);
  for (const [update, why] of [...failed].sort()) console.log(`  ${update}  ${why}`);
}
