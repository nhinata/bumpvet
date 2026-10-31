import { isObject, str, type JsonObject } from './utils/json.js';
import type { Change } from './types/lockfile.js';
import { REGISTRY } from './types/registry.js';

/**
 * A package name bumpvet can look up: an optional `@scope/` and a name, each
 * a segment that URL encoding leaves alone (so no `%`, `#`, `?`, `\\` or `/`)
 * and that does not start with "." (no path tricks). registryFetcher puts it
 * into the registry URL with only its `/` encoded.
 */
function validName(name: string): boolean {
  const segments = name.startsWith('@') ? name.slice(1).split('/') : [name];
  if (segments.length !== (name.startsWith('@') ? 2 : 1)) return false;
  return segments.every((s) => s !== '' && !s.startsWith('.') && encodeURIComponent(s) === s);
}

/**
 * Where an entry comes from, when bumpvet cannot vet it as a version of the
 * public registry. Without a `resolved` (or with an empty one) npm fetches the
 * version from the registry, as it does for omit-lockfile-registry-resolved
 * (DESIGN.md, threat model). A registry URL is not judged here: whether it is
 * the right tarball is checked against the registry itself (see
 * `tarball-mismatch` in signals.ts). npm reads a null field as missing, and
 * uses any other value as it is, so a non-string is not read as missing.
 */
function elsewhere(
  entry: JsonObject,
  name: string,
  version: string,
  resolved: string | undefined,
): string | undefined {
  for (const field of ['name', 'version', 'resolved', 'integrity']) {
    const value = entry[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `invalid ${field} ${JSON.stringify(value)}`;
    }
  }
  if (!validName(name)) return `invalid package name ${JSON.stringify(name)}`;
  if (resolved && !resolved.startsWith(REGISTRY)) return resolved;
  if (!version) return 'no version in the lockfile';
  return undefined;
}

export interface LockPackage {
  name: string;
  /** Empty when the entry has none (then `elsewhere` says so). */
  version: string;
  integrity?: string;
  /** The URL the lockfile records, whatever the source. */
  resolved?: string;
  /** Set when the package does not come from the public registry: what it comes from instead. */
  elsewhere?: string;
}

/**
 * Reads the installed packages of a package-lock.json (lockfileVersion 2 or 3).
 * Only links are left out (workspaces and `file:` folders, whose targets are
 * outside `node_modules/`): npm downloads nothing for them. Bundled
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
    if (!path.includes('node_modules/') || !isObject(entry) || entry.link === true) continue;
    const name =
      str(entry.name) || path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const version = str(entry.version) ?? '';
    const resolved = str(entry.resolved) || undefined;
    out.set(path, {
      name,
      version,
      integrity: str(entry.integrity),
      resolved,
      elsewhere: elsewhere(entry, name, version, resolved),
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
function artifactKey(p: LockPackage): string {
  return JSON.stringify([
    p.elsewhere,
    p.integrity ? `integrity:${p.integrity}` : `url:${p.resolved ?? ''}`,
  ]);
}

/** The entries of a lockfile, the least nested first (the sort is stable). */
function shallowFirst(entries: Map<string, LockPackage>): [string, LockPackage][] {
  return [...entries]
    .map((entry) => ({ entry, depth: entry[0].split('node_modules/').length }))
    .sort((a, b) => a.depth - b.depth)
    .map(({ entry }) => entry);
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
 */
export function diffLockfiles(oldText: string | null, newText: string): Change[] {
  const before =
    oldText === null ? new Map<string, LockPackage>() : parseLockfile(oldText, 'the old lockfile');
  const byName = new Map<string, LockPackage[]>();
  for (const [, p] of shallowFirst(before)) {
    const list = byName.get(p.name);
    if (list) list.push(p);
    else byName.set(p.name, [p]);
  }
  const seen = new Set<string>();
  const changes: Change[] = [];
  for (const [path, pkg] of parseLockfile(newText, 'the new lockfile')) {
    const named = byName.get(pkg.name) ?? [];
    const sameVersion = named.filter((p) => p.version === pkg.version);
    const artifact = artifactKey(pkg);
    if (sameVersion.some((p) => artifactKey(p) === artifact)) continue;

    const old = before.get(path);
    const atPath = old?.name === pkg.name ? old : undefined;
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
    if (pkg.elsewhere) change.source = pkg.elsewhere;
    if (compared?.elsewhere) change.fromSource = compared.elsewhere;
    if (copy?.integrity && pkg.integrity && copy.integrity !== pkg.integrity) {
      change.fromIntegrity = copy.integrity;
    }

    const key = JSON.stringify([
      change.name,
      change.to,
      artifact,
      change.from,
      change.fromSource,
      change.fromIntegrity,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push(change);
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name) || a.to.localeCompare(b.to));
}
