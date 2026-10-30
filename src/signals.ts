import { KINDS, type Content } from './content.js';
import {
  SIGNALS,
  type Change,
  type Packument,
  type Signal,
  type SignalId,
  type VersionManifest,
} from './types.js';

export interface SignalOptions {
  /** The moment the update is being vetted. */
  now: Date;
  /** How many earlier versions count as "the usual" publishers. */
  baselineSize?: number;
  /** A version younger than this is a fresh publish. */
  freshHours?: number;
}

/** A signal, with the group SIGNALS gives it. */
const signal = <K extends SignalId>(id: K, before: string, after: string): Signal =>
  // TypeScript does not tie SIGNALS[id] to id's own member of Signal; the group is that id's.
  ({ id, group: SIGNALS[id], before, after }) as Signal;

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

  const { next, reference, earlier } = versions;

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
  const tarball = next.dist?.tarball;
  if (!comparable && change.resolved !== undefined && change.resolved !== tarball) {
    signals.push(
      signal('tarball-mismatch', tarball ?? 'no tarball URL in the registry', change.resolved),
    );
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

  if (reference?.dist?.attestations && !next.dist?.attestations) {
    signals.push(signal('provenance-lost', `provenance (${reference.version})`, 'none'));
  }

  const published = own(packument.time, change.to);
  if (published) {
    const hours = (now.getTime() - Date.parse(published)) / 3_600_000;
    if (hours >= 0 && hours < freshHours) {
      signals.push(signal('fresh-publish', `>= ${freshHours}h old`, `${formatAge(hours)} old`));
    }
  }

  // Only hooks that were added or changed: removing an install script takes power away.
  const hooks = INSTALL_HOOKS.filter(
    (h) => next.scripts?.[h] && next.scripts[h] !== reference?.scripts?.[h],
  );
  if (hooks.length) {
    const show = (m: VersionManifest | undefined) =>
      hooks.map((h) => `${h}: ${m?.scripts?.[h] ?? 'none'}`).join('; ');
    signals.push(signal('install-scripts', show(reference), show(next)));
  }

  return signals;
}

/**
 * The new version and the one it is compared with, for every signal that
 * compares the two; none for a version the registry does not have.
 */
export interface ComparedVersions {
  next: VersionManifest;
  /** The version replaced, as `referenceOf` picks it; none for a first release. */
  reference?: VersionManifest;
  /** The versions published before `next`, oldest first. */
  earlier: VersionManifest[];
}

export function comparedVersions(
  change: Change,
  packument: Packument,
): ComparedVersions | undefined {
  const next = own(packument.versions, change.to);
  if (!next) return undefined;
  const earlier = versionsBefore(packument, change.to);
  return { next, reference: referenceOf(change, packument, earlier), earlier };
}

/** Whether the version replaced has to be read: only when the new one has a kind to compare. */
export const hasKinds = (content: Content): boolean => 'found' in content && content.found.size > 0;

/**
 * Kinds of code the new version has and the version replaced has in none of
 * its files (DESIGN.md, Content signals). `before` is the version replaced,
 * read when `hasKinds(after)`.
 */
export function contentSignals(
  versions: Pick<ComparedVersions, 'next' | 'reference'>,
  after: Content,
  before: Content | undefined,
): Signal[] {
  const { reference } = versions;
  // A new version that keeps its files from being read is a content change:
  // otherwise going over a limit would turn a BLOCK into a REVIEW. The version
  // replaced was published before; not reading it is only a reason to look.
  if ('unread' in after) return [signal('content-not-checked', 'files read', after.unread)];
  if (!after.found.size) return [];
  let had = new Map<string, string>();
  if (reference) {
    if (!before) throw new Error(`${reference.version} was not read`);
    if ('unread' in before)
      return [
        signal('previous-not-checked', `${reference.version}: ${before.unread}`, 'not compared'),
      ];
    had = before.found;
  }
  const signals: Signal[] = [];
  for (const [id, patterns] of Object.entries(KINDS) as [keyof typeof KINDS, object][]) {
    const added = Object.keys(patterns).filter((k) => after.found.has(k) && !had.has(k));
    if (!added.length) continue;
    signals.push(
      signal(
        id,
        reference ? `none in ${reference.version}` : 'no earlier version',
        added.map((k) => `${k} in ${after.found.get(k)}`).join('; '),
      ),
    );
  }
  return signals;
}

/**
 * The version a change is compared with: the one it replaces, or for a new
 * package or a replaced version the registry no longer has, the latest before it.
 */
function referenceOf(
  change: Change,
  packument: Packument,
  earlier: VersionManifest[],
): VersionManifest | undefined {
  return (
    (change.from !== null ? own(packument.versions, change.from) : undefined) ?? earlier.at(-1)
  );
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

/** The registry's hex `shasum` as an integrity string (`sha1-<base64>`). */
function sha1Integrity(shasum: string | undefined): string | undefined {
  return shasum && `sha1-${Buffer.from(shasum, 'hex').toString('base64')}`;
}
