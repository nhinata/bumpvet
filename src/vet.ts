import { diffLockfiles } from './lockfile.js';
import { computeSignals, tarballSignals, tarballsToRead } from './signals.js';
import { decide } from './verdict.js';
import type { Change } from './types/lockfile.js';
import type { FetchPackument, VersionManifest } from './types/registry.js';
import type { FetchTarball } from './types/tarball.js';
import type { SignalOptions } from './types/signals.js';
import type { PackageResult } from './types/verdicts.js';

export async function vetChanges(
  changes: Change[],
  fetchPackument: FetchPackument,
  fetchTarball: FetchTarball,
  opts: SignalOptions,
  concurrency = 8,
): Promise<PackageResult[]> {
  const results = new Array<PackageResult>(changes.length);
  let next = 0;
  // After one change fails the run has failed: start no more fetches, and stop
  // those under way, with any wait before a retry.
  const stop = new AbortController();
  const worker = async () => {
    while (!stop.signal.aborted && next < changes.length) {
      const i = next++;
      const change = changes[i]!;
      let packument = null;
      let signals;
      try {
        if (!change.source) packument = await fetchPackument(change.name, stop.signal);
        signals = computeSignals(change, packument, opts);
        const toRead = tarballsToRead(change, packument, signals);
        if (toRead) {
          const read = (m: VersionManifest) =>
            fetchTarball(m, `${change.name}@${m.version}`, stop.signal);
          const tarball = await read(toRead.next);
          const previous =
            toRead.previous && !('notChecked' in tarball) ? await read(toRead.previous) : undefined;
          signals.push(...tarballSignals(tarball, previous));
        }
      } catch (err) {
        stop.abort();
        throw err;
      }
      results[i] = {
        name: change.name,
        from: change.from,
        to: change.to,
        verdict: decide(signals),
        signals,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, changes.length) }, worker));
  return results;
}

export async function vetLockfiles(
  oldText: string | null,
  newText: string,
  fetchPackument: FetchPackument,
  fetchTarball: FetchTarball,
  opts: SignalOptions,
): Promise<PackageResult[]> {
  return vetChanges(diffLockfiles(oldText, newText), fetchPackument, fetchTarball, opts);
}
