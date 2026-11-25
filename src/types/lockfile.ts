/** What a lockfile change is. */

/** One package version that the lockfile change brings in. */
export interface Change {
  name: string;
  /** Version the old lockfile had ('' if its entry had none; `link to <target>` for a link), or null when the package is new. */
  from: string | null;
  /** Empty when the lockfile entry has no version; `link to <target>` for a link (also in --json output). */
  to: string;
  /** Integrity the new lockfile expects, if it records one. */
  integrity?: string;
  /** The URL the new lockfile records (`resolved`), if any. */
  resolved?: string;
  /** Where the new version comes from, when that is not the public registry (see LockPackage). */
  source?: string;
  /** Why bumpvet cannot read the new lockfile's entry as a version, if it cannot. */
  problem?: string;
  /** Where the version being replaced came from, when that was not the public registry. */
  fromSource?: string;
  /** Why bumpvet could not read the old lockfile's entry as a version, if it could not. */
  fromProblem?: string;
  /** The old lockfile's integrity for this same version, when it differs. */
  fromIntegrity?: string;
  /** The paths in the new lockfile (`node_modules/...`) the change was found at, the least nested first. */
  paths?: string[];
}
