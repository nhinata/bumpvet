import { diffLockfiles } from './lockfile.js';
import type { FetchPackument } from './registry.js';
import { computeSignals, type SignalOptions } from './signals.js';
import type { Change, PackageResult } from './types.js';
import { decide } from './verdict.js';

export async function vetChanges(
  changes: Change[],
  fetchPackument: FetchPackument,
  opts: SignalOptions,
  concurrency = 8,
): Promise<PackageResult[]> {
  const results = new Array<PackageResult>(changes.length);
  let next = 0;
  // After one fetch fails the run has failed: start no more fetches.
  let failed = false;
  const worker = async () => {
    while (!failed && next < changes.length) {
      const i = next++;
      const change = changes[i]!;
      let packument = null;
      if (!change.source) {
        try {
          packument = await fetchPackument(change.name);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
      const signals = computeSignals(change, packument, opts);
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
