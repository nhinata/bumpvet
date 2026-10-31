/** What a lockfile change is. */

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
