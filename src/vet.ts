import { diffLockfiles } from './lockfile.js';
import type { FetchPackument } from './registry.js';
import type { ReadContent } from './content.js';
import {
  comparedVersions,
  computeSignals,
  contentSignals,
  hasKinds,
  type SignalOptions,
} from './signals.js';
import type { Change, PackageResult } from './types.js';
import { decide } from './verdict.js';

export async function vetChanges(
  changes: Change[],
  fetchPackument: FetchPackument,
  readContent: ReadContent,
  opts: SignalOptions,
  concurrency = 8,
): Promise<PackageResult[]> {
  const results = new Array<PackageResult>(changes.length);
  let next = 0;
  // After one fetch fails the run has failed: start no more fetches,
  let failed = false;
  // and stop the tarball downloads under way, which can take minutes.
  const stop = new AbortController();
  const worker = async () => {
    while (!failed && next < changes.length) {
      const i = next++;
      const change = changes[i]!;
      let packument = null;
      let signals;
      try {
        if (!change.source) packument = await fetchPackument(change.name);
        signals = computeSignals(change, packument, opts);
        // A BLOCK stands whatever the files hold: they are not read.
        const versions =
          packument && decide(signals) !== 'block'
            ? comparedVersions(change, packument)
            : undefined;
        if (versions) {
          const after = await readContent(versions.next, stop.signal);
          const before =
            versions.reference && hasKinds(after)
              ? await readContent(versions.reference, stop.signal)
              : undefined;
          signals.push(...contentSignals(versions, after, before));
        }
      } catch (err) {
        failed = true;
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
  readContent: ReadContent,
  opts: SignalOptions,
): Promise<PackageResult[]> {
  return vetChanges(diffLockfiles(oldText, newText), fetchPackument, readContent, opts);
}
