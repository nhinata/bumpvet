import { kindsIn } from '../src/content.js';
import type { ReadContent } from '../src/types/content.js';
import type { FetchPackument, Packument, VersionManifest } from '../src/types/registry.js';

export interface FakeVersion {
  version: string;
  time: string;
  publisher?: string;
  provenance?: boolean;
  scripts?: Record<string, string>;
  integrity?: string;
  /** Kept in `time` but removed from `versions`, as npm does with taken-down releases. */
  removed?: boolean;
}

export function packument(name: string, versions: FakeVersion[]): Packument {
  const p: Packument = {
    name,
    time: { created: versions[0]!.time, modified: versions.at(-1)!.time },
    versions: {},
  };
  for (const v of versions) {
    p.time[v.version] = v.time;
    if (v.removed) continue;
    const m: VersionManifest = {
      version: v.version,
      _npmUser: v.publisher ? { name: v.publisher } : undefined,
      scripts: v.scripts,
      dist: {
        integrity: v.integrity ?? `sha512-${name}-${v.version}`,
        tarball: tarballUrl(name, v.version),
        attestations: v.provenance ? { url: 'x' } : undefined,
      },
    };
    p.versions[v.version] = m;
  }
  return p;
}

export function fakeRegistry(...packuments: Packument[]): FetchPackument {
  const byName = new Map(packuments.map((p) => [p.name, p]));
  return (name) => Promise.resolve(byName.get(name) ?? null);
}

export function lockfile(
  packages: Record<
    string,
    { version: string; name?: string; integrity?: string; resolved?: string; link?: boolean }
  >,
): string {
  const entries: Record<string, unknown> = { '': { name: 'app', version: '1.0.0' } };
  for (const [path, p] of Object.entries(packages)) {
    // An alias entry (`name` set) is fetched from the aliased package's URL.
    const name = p.name || path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    entries[path] = {
      resolved: `https://registry.npmjs.org/${name}/-/x-${p.version}.tgz`,
      // The same integrity packument() gives the version, as npm would record it.
      integrity: `sha512-${name}-${p.version}`,
      ...p,
    };
  }
  return JSON.stringify({ name: 'app', lockfileVersion: 3, packages: entries });
}

const tarballUrl = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/x-${version}.tgz`;

/**
 * Releases' files by `name@version`, as text, read as bumpvet reads a
 * tarball's; or, as a string, why one is not read. Any other release has no files.
 */
export function fakeContent(
  releases: Record<string, Record<string, string> | string> = {},
): ReadContent {
  const byUrl = new Map(
    Object.entries(releases).map(([key, files]) => {
      const at = key.lastIndexOf('@');
      return [tarballUrl(key.slice(0, at), key.slice(at + 1)), files];
    }),
  );
  return (m) => {
    const files = byUrl.get(m.dist?.tarball ?? '') ?? {};
    if (typeof files === 'string') return Promise.resolve({ unread: files });
    const entries = Object.entries(files).map(([path, text]): [string, Buffer] => [
      path,
      Buffer.from(text),
    ]);
    return Promise.resolve({ found: kindsIn(entries) });
  };
}
