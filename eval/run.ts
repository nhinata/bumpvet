/**
 * False-positive check: replays the last few stable releases of popular
 * packages (assumed benign) and counts how often bumpvet would speak up.
 *
 * Each update is vetted twice: one hour after publish (a Dependabot-style
 * PR opened right away) and seven days after (a team that waits).
 *
 *   npm run eval [-- --per-package 10] [--baseline 5]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slim } from '../src/registry.js';
import { computeSignals } from '../src/signals.js';
import { decide } from '../src/verdict.js';
import type { Packument, SignalId, Verdict } from '../src/types.js';

const PACKAGES = readFileSync(new URL('../../eval/packages.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const arg = (flag: string) => Number(process.argv[process.argv.indexOf(flag) + 1]) || undefined;
const perPackage = arg('--per-package') ?? 10;
const baselineSize = arg('--baseline');
const CACHE = fileURLToPath(new URL('../../eval/.cache/', import.meta.url));
const DELAYS = [
  { label: '1h after publish', hours: 1 },
  { label: '7d after publish', hours: 24 * 7 },
];

async function load(name: string): Promise<Packument> {
  const file = join(CACHE, name.replace('/', '__') + '.json');
  try {
    return slim(JSON.parse(readFileSync(file, 'utf8')), name);
  } catch {
    const res = await fetch('https://registry.npmjs.org/' + name.replace('/', '%2f'));
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    const text = await res.text();
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, text);
    return slim(JSON.parse(text), name);
  }
}

const isStable = (v: string) => /^\d+\.\d+\.\d+$/.test(v);
const compare = (a: string, b: string) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};

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
  const stable = Object.keys(p.versions)
    .filter((v) => isStable(v) && p.time[v])
    .sort((a, b) => p.time[a]!.localeCompare(p.time[b]!));
  // Pair each release with the highest earlier version below it, as an upgrade
  // would. Plain time order would pair 5.0.1 -> 4.21.2 for a backport.
  for (const to of stable.slice(-perPackage)) {
    const from = stable
      .filter((v) => p.time[v]! < p.time[to]! && compare(v, to) < 0)
      .sort(compare)
      .at(-1);
    if (!from) continue;
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
