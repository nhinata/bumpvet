import type { Change, Packument, Signal, VersionManifest } from './types.js';

export interface SignalOptions {
  /** The moment the update is being vetted. */
  now: Date;
  /** How many earlier versions count as "the usual" publishers. */
  baselineSize?: number;
  /** A version younger than this is a fresh publish. */
  freshHours?: number;
}

export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

/** Compares the new version with the versions before it and returns what changed. */
export function computeSignals(
  change: Change,
  packument: Packument | null,
  opts: SignalOptions,
): Signal[] {
  const { now, baselineSize = 20, freshHours = 72 } = opts;
  if (change.source) {
    // Nothing to compare against. Moving off the registry is how lockfile injection looks.
    const moved = change.from !== null && !change.fromSource;
    const before = change.fromSource ?? (change.from === null ? 'not installed' : 'npm registry');
    return [
      {
        id: moved ? 'source-changed' : 'not-from-registry',
        group: moved ? 'tamper' : 'origin',
        before,
        after: change.source,
      },
    ];
  }

  const signals: Signal[] = [];
  if (
    change.fromIntegrity &&
    change.integrity &&
    sameAlgorithm(change.fromIntegrity, change.integrity)
  ) {
    signals.push({
      id: 'integrity-mismatch',
      group: 'tamper',
      before: change.fromIntegrity,
      after: change.integrity,
    });
  }

  const next = packument ? own(packument.versions, change.to) : undefined;
  if (!packument || !next) {
    return [
      ...signals,
      {
        id: 'not-in-registry',
        group: 'tamper',
        before: 'lockfile',
        after: `${change.name}@${change.to} not found`,
      },
    ];
  }

  // The registry's hash in the lockfile's algorithm: sha512 usually, sha1 for old lockfiles.
  const expected = change.integrity?.startsWith('sha1-') ? next.dist?.sha1 : next.dist?.integrity;
  const comparable = !!change.integrity && !!expected && sameAlgorithm(change.integrity, expected);
  // One integrity signal is enough; the lockfile-to-lockfile one above is the more direct.
  if (
    !signals.length &&
    comparable &&
    change.integrity &&
    expected &&
    change.integrity !== expected
  ) {
    signals.push({
      id: 'integrity-mismatch',
      group: 'tamper',
      before: expected,
      after: change.integrity,
    });
  }
  // npm checks what it downloads against the lockfile's integrity, so a matching
  // integrity pins the content whatever `resolved` says. Without one it checks
  // nothing: `resolved` must then be exactly the registry's tarball for this
  // version, or npm installs whatever it points at.
  // A registry that gives no tarball URL leaves nothing to vouch for `resolved`: that fails too.
  const tarball = next.dist?.tarball;
  if (!comparable && change.resolved !== undefined && change.resolved !== tarball) {
    signals.push({
      id: 'tarball-mismatch',
      group: 'tamper',
      before: tarball ?? 'no tarball URL in the registry',
      after: change.resolved,
    });
  }

  const earlier = versionsBefore(packument, change.to);
  const reference =
    (change.from !== null ? own(packument.versions, change.from) : undefined) ?? earlier.at(-1);

  const publisher = next._npmUser?.name;
  const usual = new Set(
    earlier
      .slice(-baselineSize)
      .map((v) => v._npmUser?.name)
      .filter((n): n is string => !!n),
  );
  // A release with provenance was built by the repository's CI, which a stolen
  // token alone cannot do. Moving to trusted publishing is not an anomaly.
  if (publisher && usual.size > 0 && !usual.has(publisher) && !next.dist?.attestations) {
    signals.push({
      id: 'publisher-changed',
      group: 'origin',
      before: [...usual].join(', '),
      after: publisher,
    });
  }

  if (reference?.dist?.attestations && !next.dist?.attestations) {
    signals.push({
      id: 'provenance-lost',
      group: 'origin',
      before: `provenance (${reference.version})`,
      after: 'none',
    });
  }

  const published = own(packument.time, change.to);
  if (published) {
    const hours = (now.getTime() - Date.parse(published)) / 3_600_000;
    if (hours >= 0 && hours < freshHours) {
      signals.push({
        id: 'fresh-publish',
        group: 'timing',
        before: `>= ${freshHours}h old`,
        after: `${formatAge(hours)} old`,
      });
    }
  }

  // Only hooks that were added or changed: removing an install script takes power away.
  const hooks = INSTALL_HOOKS.filter(
    (h) => next.scripts?.[h] && next.scripts[h] !== reference?.scripts?.[h],
  );
  if (hooks.length) {
    const show = (m: VersionManifest | undefined) =>
      hooks.map((h) => `${h}: ${m?.scripts?.[h] ?? 'none'}`).join('; ');
    signals.push({
      id: 'install-scripts',
      group: 'content',
      before: show(reference),
      after: show(next),
    });
  }

  return signals;
}

/** Versions published before `version`, oldest first. */
function versionsBefore(packument: Packument, version: string): VersionManifest[] {
  const cutoff = own(packument.time, version);
  if (!cutoff) return [];
  return Object.entries(packument.time)
    .filter(([, t]) => t < cutoff)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .flatMap(([v]) => {
      // `created`, `modified` and removed versions have a time but no manifest.
      const m = own(packument.versions, v);
      return m ? [m] : [];
    });
}

function sameAlgorithm(a: string, b: string): boolean {
  return a.split('-', 1)[0] === b.split('-', 1)[0];
}

function formatAge(hours: number): string {
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${Math.round(hours)}h`;
}

/**
 * An entry the map itself holds. Keys come from lockfiles and the registry, so
 * a plain index would also find inherited members: `versions['constructor']`.
 */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
