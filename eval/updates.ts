/**
 * The benign updates the false-positive check replays: the last few stable
 * releases of each package in packages.txt, each paired with the version it
 * upgrades from. Also what both evaluations share: loading a packument, and
 * running at most a few at a time.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackumentFetcher, parsePackument } from '../src/registry.js';
import type { Packument } from '../src/types/registry.js';

export const packages = readFileSync(new URL('../../eval/packages.txt', import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
/** A numeric command-line option, as `--flag 5`. */
export const parseArg = (flag: string) =>
  Number(process.argv[process.argv.indexOf(flag) + 1]) || undefined;
/** Runs `handle` on every item, at most `size` at a time. */
export async function runPool<T>(items: T[], size: number, handle: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await handle(item);
    }),
  );
}
const perPackage = parseArg('--per-package') ?? 10;
const cacheDir = fileURLToPath(new URL('../../eval/.cache/', import.meta.url));

const fetchPackument = createPackumentFetcher();

/** A packument as bumpvet fetches it, kept in eval/.cache/ (as parsePackument leaves it) for later runs. */
export async function fetchCachedPackument(name: string): Promise<Packument> {
  const file = join(cacheDir, name.replaceAll('/', '__') + '.json');
  if (existsSync(file)) return parsePackument(JSON.parse(readFileSync(file, 'utf8')), name);
  const packument = await fetchPackument(name);
  if (!packument) throw new Error(`${name}: not in the registry`);
  mkdirSync(cacheDir, { recursive: true });
  // Write and rename, so an interrupted run never leaves half a file in the cache.
  writeFileSync(`${file}.tmp`, JSON.stringify(packument));
  renameSync(`${file}.tmp`, file);
  return packument;
}

const isStable = (v: string) => /^\d+\.\d+\.\d+$/.test(v);
const compareVersions = (a: string, b: string) => {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};

/**
 * The last stable releases of `p` (10, or `--per-package`), each with the
 * version it upgrades from.
 */
export function computeUpdates(p: Packument): { from: string; to: string }[] {
  const stable = Object.keys(p.versions)
    .filter((v) => isStable(v) && p.time[v])
    .sort((a, b) => p.time[a]!.localeCompare(p.time[b]!));
  // Pair each release with the highest earlier version below it, as an upgrade
  // would. Plain time order would pair 5.0.1 -> 4.21.2 for a backport.
  return stable.slice(-perPackage).flatMap((to) => {
    const from = stable
      .filter((v) => p.time[v]! < p.time[to]! && compareVersions(v, to) < 0)
      .sort(compareVersions)
      .at(-1);
    return from ? [{ from, to }] : [];
  });
}
