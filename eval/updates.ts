/**
 * The benign updates both evaluations replay: the last few stable releases of
 * each package in packages.txt, each paired with the version it upgrades from.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slim } from '../src/registry.js';
import type { Packument } from '../src/types/registry.js';

export const PACKAGES = readFileSync(new URL('../../eval/packages.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
/** A numeric command-line option, as `--flag 5`. */
export const arg = (flag: string) =>
  Number(process.argv[process.argv.indexOf(flag) + 1]) || undefined;
const perPackage = arg('--per-package') ?? 10;
const CACHE = fileURLToPath(new URL('../../eval/.cache/', import.meta.url));

export async function load(name: string): Promise<Packument> {
  const file = join(CACHE, name.replace('/', '__') + '.json');
  if (existsSync(file)) return slim(JSON.parse(readFileSync(file, 'utf8')), name);
  const res = await fetch('https://registry.npmjs.org/' + name.replace('/', '%2f'), {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  const text = await res.text();
  const packument = slim(JSON.parse(text), name); // check it before caching it
  mkdirSync(CACHE, { recursive: true });
  // Write and rename, so an interrupted run never leaves half a file in the cache.
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
  return packument;
}

const isStable = (v: string) => /^\d+\.\d+\.\d+$/.test(v);
const compare = (a: string, b: string) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};

/**
 * The last stable releases of `p` (10, or `--per-package`), each with the
 * version it upgrades from.
 */
export function updates(p: Packument): { from: string; to: string }[] {
  const stable = Object.keys(p.versions)
    .filter((v) => isStable(v) && p.time[v])
    .sort((a, b) => p.time[a]!.localeCompare(p.time[b]!));
  // Pair each release with the highest earlier version below it, as an upgrade
  // would. Plain time order would pair 5.0.1 -> 4.21.2 for a backport.
  return stable.slice(-perPackage).flatMap((to) => {
    const from = stable
      .filter((v) => p.time[v]! < p.time[to]! && compare(v, to) < 0)
      .sort(compare)
      .at(-1);
    return from ? [{ from, to }] : [];
  });
}
