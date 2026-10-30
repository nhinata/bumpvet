/** One package version that the lockfile change brings in. */
export interface Change {
  name: string;
  /** Version the old lockfile had ('' if its entry had none), or null when the package is new. */
  from: string | null;
  /** Empty when the lockfile entry has no version (also in --json output). */
  to: string;
  /** Integrity the new lockfile expects, if it records one. */
  integrity?: string;
  /** The URL the new lockfile records (`resolved`), if any. */
  resolved?: string;
  /** Set when the new version does not come from the public registry. */
  source?: string;
  /** Set when the version being replaced did not come from the public registry. */
  fromSource?: string;
  /** The old lockfile's integrity for this same version, when it differs. */
  fromIntegrity?: string;
}

/** Which side of the verdict table a signal belongs to (see DESIGN.md). */
export type SignalGroup = 'origin' | 'timing' | 'content' | 'tamper' | 'unchecked';

/** Every signal, in the order of DESIGN.md's table, with its group: the only place a group is set. */
export const SIGNALS = {
  'publisher-changed': 'origin',
  'provenance-lost': 'origin',
  'fresh-publish': 'timing',
  'install-scripts': 'content',
  'not-from-registry': 'origin',
  'source-changed': 'tamper',
  'integrity-mismatch': 'tamper',
  'tarball-mismatch': 'tamper',
  'not-in-registry': 'tamper',
  'hidden-code': 'content',
  'new-capability': 'content',
  'content-not-checked': 'content',
  'previous-not-checked': 'unchecked',
} as const satisfies Record<string, SignalGroup>;

export type SignalId = keyof typeof SIGNALS;

/**
 * Every signal has the same shape: what the recent versions looked like
 * (`before`) and what the new version looks like (`after`).
 */
export type Signal = {
  // Each id with its own group, so no signal can carry another group.
  [K in SignalId]: { id: K; group: (typeof SIGNALS)[K]; before: string; after: string };
}[SignalId];

/** Every verdict, the most severe first: the order reports list them in. */
export const VERDICTS = ['block', 'review', 'ok'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface PackageResult {
  name: string;
  from: string | null;
  to: string;
  verdict: Verdict;
  signals: Signal[];
}

/** The subset of an npm packument that bumpvet reads. */
export interface Packument {
  name: string;
  time: Record<string, string>;
  versions: Record<string, VersionManifest>;
}

export interface VersionManifest {
  version: string;
  _npmUser?: { name?: string };
  scripts?: Record<string, string>;
  dist?: {
    integrity?: string;
    /** The sha1 in lowercase hex; dropped when it is not one. */
    shasum?: string;
    tarball?: string;
    attestations?: unknown;
    /** As the publisher declared them. */
    unpackedSize?: number;
    fileCount?: number;
  };
}
