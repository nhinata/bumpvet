import { diffLockfiles } from './lockfile.js';
import {
  computeSignals,
  isComparable,
  computeTarballSignals,
  findTarballVersions,
} from './signals.js';
import { decideVerdict } from './verdict.js';
import type { Change } from './types/lockfile.js';
import type { PackumentFetcher, VersionManifest } from './types/registry.js';
import type { TarballFetcher } from './types/tarball.js';
import type { SignalOptions } from './types/signals.js';
import type { PackageResult } from './types/verdicts.js';

export async function vetChanges(
  changes: Change[],
  fetchPackument: PackumentFetcher,
  fetchTarball: TarballFetcher,
  opts: SignalOptions,
  concurrency = 8,
): Promise<PackageResult[]> {
  const results = new Array<PackageResult>(changes.length);
  let next = 0;
  // After one change fails the run has failed: start no more fetches, and stop
  // those under way, with any wait before a retry.
  const stop = new AbortController();
  const runWorker = async () => {
    while (!stop.signal.aborted && next < changes.length) {
      const i = next++;
      const change = changes[i]!;
      let packument = null;
      let signals;
      try {
        if (isComparable(change)) packument = await fetchPackument(change.name, stop.signal);
        signals = computeSignals(change, packument, opts);
        const toRead = findTarballVersions(change, packument, signals);
        if (toRead) {
          const fetchVersionTarball = (m: VersionManifest) =>
            fetchTarball(m, `${change.name}@${m.version}`, stop.signal);
          const tarball = await fetchVersionTarball(toRead.next);
          const previous =
            toRead.previous && !('unreadReason' in tarball)
              ? await fetchVersionTarball(toRead.previous)
              : undefined;
          signals.push(...computeTarballSignals(tarball, previous));
        }
      } catch (err) {
        stop.abort();
        throw err;
      }
      const result: PackageResult = {
        name: change.name,
        from: change.from,
        to: change.to,
        verdict: decideVerdict(signals),
        signals,
      };
      if (change.paths) result.paths = change.paths;
      results[i] = result;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, changes.length) }, runWorker));
  return results;
}

export async function vetLockfiles(
  oldText: string | null,
  newText: string,
  fetchPackument: PackumentFetcher,
  fetchTarball: TarballFetcher,
  opts: SignalOptions,
): Promise<PackageResult[]> {
  return vetChanges(diffLockfiles(oldText, newText), fetchPackument, fetchTarball, opts);
}
