import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  REGISTRY,
  type FetchPackument,
  type Packument,
  type VersionManifest,
} from '../src/types/registry.js';
import { INSTALL_HOOKS, type FetchTarball, type Tarball } from '../src/types/tarball.js';

export interface FakeVersion {
  version: string;
  time: string;
  publisher?: string;
  provenance?: boolean;
  /** What its tarball's package.json has; tarballsAsPublished serves it. */
  scripts?: Record<string, string>;
  /** Whether its tarball has a root binding.gyp. */
  bindingGyp?: boolean;
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
      dist: {
        integrity: v.integrity ?? `sha512-${name}-${v.version}`,
        tarball: tarballUrl(name, v.version),
        attestations: v.provenance ? { url: 'x' } : undefined,
      },
    };
    p.versions[v.version] = m;
    published.set(m, {
      scripts: Object.fromEntries(
        INSTALL_HOOKS.flatMap((h) => (v.scripts?.[h] ? [[h, v.scripts[h]]] : [])),
      ),
      bindingGyp: v.bindingGyp ?? false,
    });
  }
  return p;
}

export function fakeRegistry(...packuments: Packument[]): FetchPackument {
  const byName = new Map(packuments.map((p) => [p.name, p]));
  return (name) => Promise.resolve(byName.get(name) ?? null);
}

/** What packument() gave each version's tarball. */
const published = new WeakMap<VersionManifest, Tarball>();

/** The tarballs of the versions packument() made, as their FakeVersion describes them. */
export const tarballsAsPublished: FetchTarball = (manifest) =>
  Promise.resolve(published.get(manifest) ?? { scripts: {}, bindingGyp: false });

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

/** One entry of a test tarball: a regular file unless `type` says otherwise. */
export interface TarEntry {
  path: string;
  body?: string | Buffer;
  /** The tar type flag: '0' file, '1' hard link, '2' symlink, '5' folder, 'x' PAX header. */
  type?: string;
  /** The size field, when it is to differ from the body's length. */
  size?: number;
  /** The magic and version fields; `ustar\0` `00` unless given. */
  magic?: string;
  prefix?: string;
  linkpath?: string;
}

/** A tar header as node-tar writes one, with any field overridden. */
export function tarHeader(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.path, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(e.type ?? '0', 156);
  h.write(e.linkpath ?? '', 157, 100, 'utf8');
  h.write(e.magic ?? 'ustar\u000000', 257, 8, 'latin1');
  h.write(e.prefix ?? '', 345, 155, 'utf8');
  const sum = h.reduce((s, b) => s + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** An entry's header, body and padding. */
export function tarBlocks(e: TarEntry): Buffer {
  const body = Buffer.from(e.body ?? '');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([tarHeader(e, e.size ?? body.length), body, pad]);
}

/** A tarball as npm packs one, gzipped, with the end-of-archive blocks; a Buffer is put in as it is. */
export function tarball(entries: (TarEntry | Buffer)[], { gzip = true, end = true } = {}): Buffer {
  const parts = entries.map((e) => (Buffer.isBuffer(e) ? e : tarBlocks(e)));
  if (end) parts.push(Buffer.alloc(1024));
  const tar = Buffer.concat(parts);
  return gzip ? gzipSync(tar) : tar;
}

/** A PAX header (`x`) of `records`, each `<length> <key>=<value>\n` with its length right. */
export function paxHeader(records: [string, string][]): TarEntry {
  const body = records
    .map(([key, value]) => {
      const record = (len: number) => `${len} ${key}=${value}\n`;
      let len = record(0).length;
      while (Buffer.byteLength(record(len)) !== len) len = Buffer.byteLength(record(len));
      return record(len);
    })
    .join('');
  return { path: 'PaxHeader', type: 'x', body };
}

/** A PAX header giving the next entry a long `path`. */
export const paxPath = (path: string) => paxHeader([['path', path]]);

/** A manifest for `tgz` and a fetch that serves it at its tarball URL. */
export function served(tgz: Buffer, url = `${REGISTRY}pkg/-/pkg-1.0.0.tgz`) {
  const manifest: VersionManifest = {
    version: '1.0.0',
    dist: {
      tarball: url,
      integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
    },
  };
  let calls = 0;
  const fetchImpl = ((requested: string) => {
    calls++;
    return Promise.resolve(
      requested === url ? new Response(new Uint8Array(tgz)) : new Response(null, { status: 404 }),
    );
  }) as unknown as typeof fetch;
  return { manifest, fetchImpl, calls: () => calls };
}
