import { diffLockfiles } from './lockfile.js';
import { computeSignals } from './signals.js';
import { decide } from './verdict.js';
import type { Change } from './types/lockfile.js';
import type { FetchPackument } from './types/registry.js';
import type { SignalOptions } from './types/signals.js';
import type { PackageResult } from './types/verdicts.js';

export async function vetChanges(
  changes: Change[],
  fetchPackument: FetchPackument,
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
  opts: SignalOptions,
): Promise<PackageResult[]> {
  return vetChanges(diffLockfiles(oldText, newText), fetchPackument, opts);
}
