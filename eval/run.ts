/**
 * False-positive check: replays the last few stable releases of popular
 * packages (assumed benign) and counts how often bumpvet would speak up.
 *
 * Each update is vetted twice: one hour after publish (a Dependabot-style
 * PR opened right away) and seven days after (a team that waits).
 *
 *   npm run eval [-- --per-package 10] [--baseline 5]
 */
import { computeSignals } from '../src/signals.js';
import { decide } from '../src/verdict.js';
import type { SignalId, Verdict } from '../src/types.js';
import { PACKAGES, load, updates } from './updates.js';

const arg = (flag: string) => Number(process.argv[process.argv.indexOf(flag) + 1]) || undefined;
const perPackage = arg('--per-package') ?? 10;
const baselineSize = arg('--baseline');
const DELAYS = [
  { label: '1h after publish', hours: 1 },
  { label: '7d after publish', hours: 24 * 7 },
];

interface Row {
  pkg: string;
  from: string;
  to: string;
  delay: string;
  verdict: Verdict;
  signals: SignalId[];
}

const rows: Row[] = [];
for (const name of PACKAGES) {
  const p = await load(name);
  for (const { from, to } of updates(p, perPackage)) {
    const change = { name, from, to };
    for (const d of DELAYS) {
      const now = new Date(Date.parse(p.time[change.to]!) + d.hours * 3_600_000);
      const signals = computeSignals(change, p, { now, baselineSize });
      rows.push({
        pkg: name,
        ...change,
        delay: d.label,
        verdict: decide(signals),
        signals: signals.map((s) => s.id),
      });
    }
  }
}

const pct = (n: number, total: number) => `${((100 * n) / total).toFixed(1)}%`;
for (const d of DELAYS) {
  const set = rows.filter((r) => r.delay === d.label);
  const n = set.length;
  console.log(`\n== ${d.label}: ${n} updates of ${PACKAGES.length} packages`);
  for (const v of ['ok', 'review', 'block'] as const) {
    const c = set.filter((r) => r.verdict === v).length;
    console.log(`  ${v.padEnd(7)} ${String(c).padStart(4)}  ${pct(c, n)}`);
  }
  const bySignal = new Map<string, number>();
  for (const r of set) for (const s of r.signals) bySignal.set(s, (bySignal.get(s) ?? 0) + 1);
  console.log('  signals fired:');
  for (const [s, c] of [...bySignal].sort((a, b) => b[1] - a[1]))
    console.log(`    ${s.padEnd(18)} ${String(c).padStart(4)}  ${pct(c, n)}`);
}

const flagged = rows.filter((r) => r.delay === DELAYS[1]!.label && r.verdict !== 'ok');
console.log(`\n== non-OK at ${DELAYS[1]!.label} (${flagged.length})`);
for (const r of flagged)
  console.log(`  ${r.verdict.padEnd(6)} ${r.pkg} ${r.from} -> ${r.to}  [${r.signals.join(', ')}]`);
