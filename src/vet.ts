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
  const results: PackageResult[] = new Array(changes.length);
  let next = 0;
  const worker = async () => {
    while (next < changes.length) {
      const i = next++;
      const change = changes[i]!;
      const packument = change.source ? null : await fetchPackument(change.name);
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
