import { isObject, str } from './json.js';
import type { Change } from './types.js';

const REGISTRY = 'https://registry.npmjs.org/';

// A package name: an optional scope and one segment, neither starting with "." (no path tricks).
const NAME = /^(?:@[^/@\s.][^/@\s]*\/)?[^/@\s.][^/@\s]*$/;

/**
 * Where an entry really comes from, when that is not the public registry
 * package its name says. A registry URL is trusted only if its path, parsed as
 * a URL (where `..`, `%2e%2e` and `\` all count), is a tarball of that very
 * package: otherwise `name` could claim one package while `resolved` fetches
 * another.
 */
function elsewhere(name: string, resolved?: string, integrity?: string): string | undefined {
  if (!NAME.test(name)) return `invalid package name ${JSON.stringify(name)}`;
  // npm leaves `resolved` out for registry packages with omit-lockfile-registry-resolved.
  if (resolved === undefined) return integrity ? undefined : 'unknown source';
  if (!resolved.startsWith(REGISTRY)) return resolved || 'unknown source';
  const tarball = new RegExp(`^/${escapeRegExp(name)}/-/[^/]+\\.tgz$`);
  if (!tarball.test(new URL(resolved).pathname)) return `${resolved} (not ${name})`;
  return undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface LockPackage {
  name: string;
  version: string;
  integrity?: string;
  /** Where the package comes from when that is not the public registry (git, file:, another registry). */
  elsewhere?: string;
}

/**
 * Reads the installed packages of a package-lock.json (lockfileVersion 2 or 3).
 * Workspace links and bundled dependencies are left out: they are not
 * downloaded on their own. The text may come from a pull request, so every
 * field is checked for its type; `label` names the file in errors.
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
    const version = str(entry.version);
    if (entry.link === true || entry.inBundle === true || !version) continue;
    const name =
      str(entry.name) || path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const resolved = str(entry.resolved);
    const integrity = str(entry.integrity);
    out.set(path, { name, version, integrity, elsewhere: elsewhere(name, resolved, integrity) });
  }
  return out;
}

/** True when two entries of the same version would install the same thing. */
function sameArtifact(a: LockPackage, b: LockPackage): boolean {
  return (
    a.elsewhere === b.elsewhere && (!a.integrity || !b.integrity || a.integrity === b.integrity)
  );
}

/**
 * What the new lockfile installs that the old one did not. A version that only
 * moved to another path was already trusted; the same version from another
 * source or with another integrity was not.
 */
export function diffLockfiles(oldText: string | null, newText: string): Change[] {
  const before =
    oldText === null ? new Map<string, LockPackage>() : parseLockfile(oldText, 'the old lockfile');
  const old = [...before.values()];
  const seen = new Set<string>();
  const changes: Change[] = [];
  for (const [path, pkg] of parseLockfile(newText, 'the new lockfile')) {
    const sameVersion = old.filter((p) => p.name === pkg.name && p.version === pkg.version);
    if (sameVersion.some((p) => sameArtifact(p, pkg))) continue;

    const atPath = before.get(path);
    const prev =
      sameVersion[0] ?? (atPath?.name === pkg.name ? atPath : old.find((p) => p.name === pkg.name));
    const change: Change = {
      name: pkg.name,
      from: prev?.version ?? null,
      to: pkg.version,
      integrity: pkg.integrity,
    };
    if (pkg.elsewhere) change.source = pkg.elsewhere;
    if (prev?.elsewhere) change.fromSource = prev.elsewhere;
    if (
      prev &&
      prev.version === pkg.version &&
      prev.integrity &&
      pkg.integrity &&
      prev.integrity !== pkg.integrity
    ) {
      change.fromIntegrity = prev.integrity;
    }

    // What gets vetted is the new artifact; it is listed once, against the first version it replaces.
    const key = JSON.stringify([change.name, change.to, change.source, change.integrity]);
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push(change);
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name) || a.to.localeCompare(b.to));
}
