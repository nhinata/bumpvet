import type { Change } from './types/lockfile.js';
import { NO_TARBALL, type Packument, type VersionManifest } from './types/registry.js';
import { INSTALL_HOOKS, type NotChecked, type Tarball } from './types/tarball.js';
import { SIGNALS, type Signal, type SignalId, type SignalOptions } from './types/signals.js';

/** A signal, with the group SIGNALS gives it. */
const signal = <K extends SignalId>(id: K, before: string, after: string): Signal =>
  // TypeScript does not tie SIGNALS[id] to id's own member of Signal; the group is that id's.
  ({ id, group: SIGNALS[id], before, after }) as Signal;

/**
 * Compares the new version with the versions before it and returns what
 * changed, from the registry's metadata; tarballSignals adds what the
 * tarballs say.
 */
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
    return [signal(moved ? 'source-changed' : 'not-from-registry', before, change.source)];
  }

  const signals: Signal[] = [];
  if (
    change.fromIntegrity &&
    change.integrity &&
    sameAlgorithm(change.fromIntegrity, change.integrity)
  ) {
    signals.push(signal('integrity-mismatch', change.fromIntegrity, change.integrity));
  }

  const versions = packument ? comparedVersions(change, packument) : undefined;
  if (!packument || !versions) {
    return [
      ...signals,
      signal('not-in-registry', 'lockfile', `${change.name}@${change.to} not found`),
    ];
  }

  const { next, replaced, earlier } = versions;

  // The registry's hash in the lockfile's algorithm: sha512 usually, sha1 for old lockfiles,
  // which the registry gives as `shasum` (and, for some old versions, as `integrity`).
  const expected = change.integrity?.startsWith('sha1-')
    ? (sha1Integrity(next.dist?.shasum) ?? next.dist?.integrity)
    : next.dist?.integrity;
  const comparable = !!change.integrity && !!expected && sameAlgorithm(change.integrity, expected);
  // One integrity signal is enough; the lockfile-to-lockfile one above is the more direct.
  if (
    !signals.length &&
    comparable &&
    change.integrity &&
    expected &&
    // The whole string: npm accepts content that matches any one of several hashes,
    // so the registry's hash beside another must not count as a match (DESIGN.md).
    change.integrity !== expected
  ) {
    signals.push(signal('integrity-mismatch', expected, change.integrity));
  }
  // Without an integrity to compare with the registry's, nothing ties the content
  // to the registry, so `resolved` must be the registry's tarball exactly
  // (DESIGN.md, threat model). With no tarball URL from the registry, that fails too.
  const tarballUrl = next.dist?.tarball;
  if (!comparable && change.resolved !== undefined && change.resolved !== tarballUrl) {
    signals.push(signal('tarball-mismatch', tarballUrl ?? NO_TARBALL, change.resolved));
  }

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
    signals.push(signal('publisher-changed', [...usual].join(', '), publisher));
  }

  // Any stable version of the line counts, and the version replaced, which may
  // predate provenance; not `reference`'s stand-in for a new package, which may
  // be of another line. An old line is not held to a newer one's (DESIGN.md, Decisions).
  const attested =
    earlier
      .filter((v) => !v.version.includes('-') && lineOf(v.version) === lineOf(change.to))
      .filter((v) => v.dist?.attestations)
      .at(-1) ?? (replaced?.dist?.attestations ? replaced : undefined);
  if (attested && !next.dist?.attestations) {
    signals.push(signal('provenance-lost', `provenance (${attested.version})`, 'none'));
  }

  const published = own(packument.time, change.to);
  if (published) {
    const hours = (now.getTime() - Date.parse(published)) / 3_600_000;
    if (hours >= 0 && hours < freshHours) {
      signals.push(signal('fresh-publish', `>= ${freshHours}h old`, `${formatAge(hours)} old`));
    }
  }

  return signals;
}

/**
 * The manifests whose tarballs are to be read, given what computeSignals
 * found: the new version's, and the one it is compared with, if any. None
 * when the lockfile already installs something other than the registry's
 * release (a tamper signal), or when the registry has no such version.
 */
export function tarballsToRead(
  change: Change,
  packument: Packument | null,
  signals: Signal[],
): { next: VersionManifest; previous?: VersionManifest } | undefined {
  if (change.source || !packument || signals.some((s) => s.group === 'tamper')) return undefined;
  const versions = comparedVersions(change, packument);
  return versions && { next: versions.next, previous: versions.reference };
}

/**
 * What the tarballs say (DESIGN.md, Decisions): `install-scripts` for an
 * install hook of the new version's package.json, or a root binding.gyp, that
 * the version it is compared with (`previous`) did not have; removing one
 * takes power away. None for `previous` when there is no version to compare
 * with.
 */
export function tarballSignals(
  tarball: Tarball | NotChecked,
  previous: Tarball | NotChecked | undefined,
): Signal[] {
  if ('notChecked' in tarball) {
    return [signal('tarball-not-read', 'tarball read', tarball.notChecked)];
  }
  const after = installs(tarball);
  const before = previous && !('notChecked' in previous) ? installs(previous) : {};
  const added = INSTALLS.filter((k) => after[k] && after[k] !== before[k]);
  if (!added.length) return [];
  const was =
    previous && 'notChecked' in previous
      ? `not read: ${previous.notChecked}`
      : installsText(added, before);
  return [signal('install-scripts', was, installsText(added, after))];
}

/** What npm can run from a tarball when it installs it (DESIGN.md, threat model). */
const INSTALLS = [...INSTALL_HOOKS, 'binding.gyp'] as const;
type Installs = Partial<Record<(typeof INSTALLS)[number], string>>;

function installs(tarball: Tarball): Installs {
  return { ...tarball.scripts, 'binding.gyp': tarball.bindingGyp ? 'present' : undefined };
}

/** `keys` as `install: <script>; …`, with `none` where `installs` has none. */
function installsText(keys: (typeof INSTALLS)[number][], installs: Installs) {
  return keys.map((k) => `${k}: ${installs[k] ?? 'none'}`).join('; ');
}

/**
 * The new version and the one it is compared with, for every signal that
 * compares the two; none for a version the registry does not have.
 */
interface ComparedVersions {
  next: VersionManifest;
  /** The version the lockfile replaces, if the registry still has it. */
  replaced?: VersionManifest;
  /**
   * What the new version is compared with: `replaced`, or for a new package or
   * a replaced version the registry no longer has, the latest before it.
   */
  reference?: VersionManifest;
  /** The versions published before `next`, oldest first. */
  earlier: VersionManifest[];
}

function comparedVersions(change: Change, packument: Packument): ComparedVersions | undefined {
  const next = own(packument.versions, change.to);
  if (!next) return undefined;
  const earlier = versionsBefore(packument, change.to);
  const replaced = change.from !== null ? own(packument.versions, change.from) : undefined;
  return { next, replaced, reference: replaced ?? earlier.at(-1), earlier };
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

/** The versions a caret range moves through: the same major, or below 1.0.0 the same minor. */
function lineOf(version: string): string {
  const [major, minor] = version.split('.');
  return major === '0' ? `0.${minor}` : (major ?? '');
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

/** The registry's hex `shasum` as an integrity string (`sha1-<base64>`). */
function sha1Integrity(shasum: string | undefined): string | undefined {
  return shasum && `sha1-${Buffer.from(shasum, 'hex').toString('base64')}`;
}
