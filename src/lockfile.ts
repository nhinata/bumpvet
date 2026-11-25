import { isObject, parseString, type JsonObject } from './utils/json.js';
import type { Change } from './types/lockfile.js';
import { REGISTRY } from './types/registry.js';

/**
 * A package name bumpvet can look up: an optional `@scope/` and a name, each
 * a segment that URL encoding leaves alone (so no `%`, `#`, `?`, `\\` or `/`)
 * and that does not start with "." (no path tricks). createPackumentFetcher puts it
 * into the registry URL with only its `/` encoded.
 */
function isValidName(name: string): boolean {
  const segments = name.startsWith('@') ? name.slice(1).split('/') : [name];
  if (segments.length !== (name.startsWith('@') ? 2 : 1)) return false;
  return segments.every((s) => s !== '' && !s.startsWith('.') && encodeURIComponent(s) === s);
}

/**
 * What is wrong with an entry's fields, if anything. npm reads a null field as
 * missing, and uses any other value as it is, so a non-string is not read as
 * missing. `link` is accepted only in the form npm writes.
 */
function findFieldProblem(entry: JsonObject): string | undefined {
  if (entry.link !== undefined && entry.link !== null && entry.link !== true) {
    return `invalid link ${JSON.stringify(entry.link)}`;
  }
  for (const field of ['name', 'version', 'resolved', 'integrity']) {
    const value = entry[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `invalid ${field} ${JSON.stringify(value)}`;
    }
  }
  return undefined;
}

/**
 * Why bumpvet cannot read an entry as a version, if it cannot: a field of the
 * wrong type, a name it cannot look up, or no version. A missing version counts
 * only for an entry from the registry: npm writes an entry for a local tarball
 * without a version when its package.json has none (DESIGN.md, threat model).
 */
function findEntryProblem(
  entry: JsonObject,
  name: string,
  version: string,
  source: string | undefined,
): string | undefined {
  const invalid = findFieldProblem(entry);
  if (invalid) return invalid;
  if (!isValidName(name)) return `invalid package name ${JSON.stringify(name)}`;
  if (!version && !source) return 'no version in the lockfile';
  return undefined;
}

export interface LockPackage {
  name: string;
  /** Empty when the entry has none; a link's target for a link. */
  version: string;
  integrity?: string;
  /** The URL the lockfile records, whatever the source. */
  resolved?: string;
  /**
   * Where the package comes from when that is not the public registry: the
   * `resolved` URL, or `link to <target>` for a link. Without a `resolved` (or
   * with an empty one) npm fetches the version from the registry, as it does
   * for omit-lockfile-registry-resolved (DESIGN.md, threat model). A registry
   * URL is not judged here: whether it is the right tarball is checked against
   * the registry itself (see `tarball-mismatch` in signals.ts).
   */
  source?: string;
  /** Why bumpvet cannot read the entry as a version, if it cannot. */
  problem?: string;
  link?: true;
}

/**
 * Reads the installed packages of a package-lock.json (lockfileVersion 2 or 3).
 * A link is read by its path and target alone, so that it stays the same link
 * when its workspace changes version (DESIGN.md, decisions). Bundled
 * dependencies are kept (DESIGN.md, decisions). The text may come from a pull
 * request, so every field is checked for its type; `label` names the file in
 * errors.
 */
export function parseLockfile(text: string, label = 'lockfile'): Map<string, LockPackage> {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON`, { cause: err });
  }
  if (
    !isObject(lock) ||
    !isObject(lock.packages) ||
    (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)
  ) {
    throw new Error(`${label}: only package-lock.json with lockfileVersion 2 or 3 is supported`);
  }
  const out = new Map<string, LockPackage>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || !isObject(entry)) continue;
    const pathName = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const resolved = parseString(entry.resolved) || undefined;
    if (entry.link === true) {
      const target = `link to ${resolved ?? 'nothing'}`;
      out.set(path, {
        name: pathName,
        version: target,
        source: resolved && target,
        problem: findFieldProblem(entry) ?? (resolved ? undefined : target),
        link: true,
      });
      continue;
    }
    const name = parseString(entry.name) || pathName;
    const version = parseString(entry.version) ?? '';
    const source = resolved && !resolved.startsWith(REGISTRY) ? resolved : undefined;
    out.set(path, {
      name,
      version,
      integrity: parseString(entry.integrity),
      resolved,
      source,
      problem: findEntryProblem(entry, name, version, source),
    });
  }
  return out;
}

/**
 * What an entry installs, as a key: two entries of the same package and
 * version install the same thing exactly when their keys are equal. With an
 * integrity, npm checks the content against it, so the integrity identifies
 * the artifact whatever `resolved` says; without one, only the URL does.
 */
function computeArtifactKey(p: LockPackage): string {
  return JSON.stringify([
    p.source,
    p.problem,
    p.integrity ? `integrity:${p.integrity}` : `url:${p.resolved ?? ''}`,
  ]);
}

/** `items` with the least nested path first, in their order otherwise (the sort is stable). */
function sortShallowFirst<T>(items: Iterable<T>, getPath: (item: T) => string): T[] {
  return [...items]
    .map((item) => ({ item, depth: getPath(item).split('node_modules/').length }))
    .sort((a, b) => a.depth - b.depth)
    .map(({ item }) => item);
}

/**
 * What the new lockfile installs that the old one did not. A version that only
 * moved to another path was already trusted; the same version from another
 * source or with another integrity was not. Each change is compared with two
 * old entries, one per purpose:
 *
 * - for tamper signals (`fromSource`, `fromIntegrity`), the old copy of the
 *   same version: the one at the same path, else the least nested one;
 * - for what changed (`from`, which install-scripts and provenance-lost
 *   compare with), the old entry at the same path, else that copy of the same
 *   version, else the least nested old entry of the name.
 *
 * Without an old copy of the same version, the second is used for both. A new
 * artifact is listed once per distinct comparison: two paths that replaced
 * different versions give two changes, so that neither comparison is lost.
 * Each change has the paths it was found at (see Change).
 *
 * A link has no version to compare, so it is compared only with the old entry
 * at its path, and no other entry is compared with a link.
 */
export function diffLockfiles(oldText: string | null, newText: string): Change[] {
  const before =
    oldText === null ? new Map<string, LockPackage>() : parseLockfile(oldText, 'the old lockfile');
  const byName = new Map<string, LockPackage[]>();
  for (const [, p] of sortShallowFirst(before, ([path]) => path)) {
    if (p.link) continue;
    const list = byName.get(p.name);
    if (list) list.push(p);
    else byName.set(p.name, [p]);
  }
  const seen = new Map<string, Change & { paths: string[] }>();
  const addChange = (path: string, change: Change, artifact: string) => {
    const key = JSON.stringify([
      change.name,
      change.to,
      artifact,
      change.from,
      change.fromSource,
      change.fromProblem,
      change.fromIntegrity,
    ]);
    const listed = seen.get(key);
    if (listed) listed.paths.push(path);
    else seen.set(key, { ...change, paths: [path] });
  };
  for (const [path, pkg] of parseLockfile(newText, 'the new lockfile')) {
    const old = before.get(path);
    const artifact = computeArtifactKey(pkg);
    if (pkg.link) {
      if (old?.link && old.version === pkg.version && computeArtifactKey(old) === artifact)
        continue;
      const change: Change = { name: pkg.name, from: old?.version ?? null, to: pkg.version };
      if (pkg.source) change.source = pkg.source;
      if (pkg.problem) change.problem = pkg.problem;
      if (old?.source) change.fromSource = old.source;
      if (old?.problem) change.fromProblem = old.problem;
      addChange(path, change, artifact);
      continue;
    }
    const named = byName.get(pkg.name) ?? [];
    const sameVersion = named.filter((p) => p.version === pkg.version);
    if (sameVersion.some((p) => computeArtifactKey(p) === artifact)) continue;

    const atPath = !old?.link && old?.name === pkg.name ? old : undefined;
    const copy = atPath?.version === pkg.version ? atPath : sameVersion[0];
    const replaced = atPath ?? copy ?? named[0];
    const compared = copy ?? replaced;
    const change: Change = {
      name: pkg.name,
      from: replaced?.version ?? null,
      to: pkg.version,
      integrity: pkg.integrity,
    };
    if (pkg.resolved) change.resolved = pkg.resolved;
    if (pkg.source) change.source = pkg.source;
    if (pkg.problem) change.problem = pkg.problem;
    if (compared?.source) change.fromSource = compared.source;
    if (compared?.problem) change.fromProblem = compared.problem;
    if (copy?.integrity && pkg.integrity && copy.integrity !== pkg.integrity) {
      change.fromIntegrity = copy.integrity;
    }
    addChange(path, change, artifact);
  }
  const changes = [...seen.values()];
  for (const change of changes) change.paths = sortShallowFirst(change.paths, (path) => path);
  return changes.sort((a, b) => a.name.localeCompare(b.name) || a.to.localeCompare(b.to));
}
