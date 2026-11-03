import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import {
  NPM_FETCH_TIMEOUT,
  Transient,
  bodyFailed,
  discard,
  request,
  wait,
  withRetries,
} from './registry.js';
import { isObject, str } from './utils/json.js';
import { NO_TARBALL, REGISTRY } from './types/registry.js';
import {
  INSTALL_HOOKS,
  type FetchTarball,
  type NotChecked,
  type Tarball,
} from './types/tarball.js';

/** Bounds on reading one tarball (DESIGN.md, Decisions). */
const LIMITS = { downloadBytes: 256_000_000, unpackedBytes: 512_000_000, fileBytes: 128_000_000 };
/** The largest PAX header node-tar reads; it ignores a larger one. */
const MAX_META = 1024 * 1024;

const MB = (bytes: number) => `${bytes / 1_000_000} MB`;

/** A tarball bumpvet does not read: over a limit, or not in a form it reads (TarScanner). */
class Unreadable extends Error {}

/**
 * Reads tarballs from the registry: the one a manifest names, checked against
 * the registry's hash, read as it arrives and never run. Network errors and
 * the statuses npm retries are tried again (withRetries). A tarball that does
 * not match the registry's hash fails the run, as a broken registry does.
 *
 * Each tarball is read once, and later calls share that read, whatever signal
 * they pass: give one fetcher one signal, as a run does.
 */
export function tarballFetcher(
  fetchImpl: typeof fetch = fetch,
  waitImpl = wait,
  limits = LIMITS,
): FetchTarball {
  const cache = new Map<string, Promise<Tarball | NotChecked>>();
  return (manifest, what, signal) => {
    const { tarball: url, integrity, shasum } = manifest.dist ?? {};
    const key = JSON.stringify([url, integrity, shasum]);
    let p = cache.get(key);
    if (!p) {
      p = (async (): Promise<Tarball | NotChecked> => {
        if (!url) return { notChecked: NO_TARBALL };
        if (!url.startsWith(REGISTRY)) return { notChecked: `tarball not on the registry: ${url}` };
        // sha512 where the registry has it; versions from before 2017 have only sha1.
        const sha512 = integrity?.split(/\s+/).find((h) => h.startsWith('sha512-'));
        if (!sha512 && !shasum) return { notChecked: 'no sha512 or sha1 hash in the registry' };
        const name = `the tarball of ${what}`;
        const read = await withRetries(
          () => readTarball(fetchImpl, url, name, signal, limits, sha512 ? 'sha512' : 'sha1'),
          signal,
          waitImpl,
        );
        if ('notChecked' in read) return read;
        const ok = sha512
          ? sha512 === `sha512-${read.digest.toString('base64')}`
          : shasum === read.digest.toString('hex');
        if (!ok) throw new Error(`${name} does not match the registry's hash`);
        return read.read;
      })();
      cache.set(key, p);
    }
    return p;
  };
}

/**
 * One download of a tarball, read as it arrives: what it says, or why it was
 * not read, and its hash. A tarball that cannot be read is still hashed to its
 * end, so that a damaged download fails the hash check instead of passing as
 * unreadable; one over a limit is not, since no more of it is downloaded.
 */
async function readTarball(
  fetchImpl: typeof fetch,
  url: string,
  what: string,
  signal: AbortSignal | undefined,
  limits: typeof LIMITS,
  algorithm: 'sha512' | 'sha1',
): Promise<NotChecked | { read: Tarball | NotChecked; digest: Buffer }> {
  const res = await request(fetchImpl, url, what, signal, NPM_FETCH_TIMEOUT);
  // The registry lists the version, so a missing tarball is the registry's fault.
  if (!res) throw new Transient(`registry returned 404 for ${what}`);
  const over = { notChecked: `over ${MB(limits.downloadBytes)} to download` };
  if (Number(res.headers.get('content-length')) > limits.downloadBytes) {
    await discard(res);
    return over;
  }
  const hash = createHash(algorithm);
  const scanner = new TarScanner(limits);
  let unreadable: string | undefined;
  // Anything but Unreadable from the scanner is a bug in bumpvet, not a
  // property of the tarball: it fails the run.
  let bug: Error | undefined;
  const gunzip = createGunzip();
  gunzip.on('data', (chunk: Buffer) => {
    if (unreadable || bug) return;
    try {
      scanner.write(chunk);
    } catch (err) {
      if (err instanceof Unreadable) unreadable = err.message;
      else bug = err instanceof Error ? err : new Error(String(err));
    }
  });
  const ended = new Promise<void>((resolve) => {
    gunzip.on('end', resolve);
    gunzip.on('error', () => {
      unreadable ??= 'not a gzip file npm can read';
      resolve();
    });
  });
  let size = 0;
  try {
    // Leaving the loop early cancels the body.
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > limits.downloadBytes) {
        gunzip.destroy();
        return over;
      }
      hash.update(chunk);
      if (!unreadable && !bug && !gunzip.write(chunk)) {
        await new Promise<void>((resolve) => {
          // Whichever comes first; the other listener is taken off again.
          const done = () => {
            gunzip.off('drain', done);
            gunzip.off('error', done);
            resolve();
          };
          gunzip.once('drain', done);
          gunzip.once('error', done);
        });
      }
    }
  } catch (err) {
    gunzip.destroy();
    throw bodyFailed(err, what);
  }
  gunzip.end();
  await ended;
  if (bug) throw bug;
  let read: Tarball | NotChecked;
  if (unreadable) {
    read = { notChecked: unreadable };
  } else {
    try {
      scanner.end();
      read = scanner.tarball();
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err;
      read = { notChecked: err.message };
    }
  }
  return { read, digest: hash.digest() };
}

/**
 * The install hooks of a tarball's package.json, as npm reads them when it
 * installs the package: a value that is not a string, or is empty, runs
 * nothing (read-package-json-fast drops it).
 */
function packageJsonHooks(packageJson: Buffer | undefined): Tarball['scripts'] {
  if (!packageJson) return {};
  let pkg: unknown;
  try {
    // npm's JSON parser drops a byte order mark.
    pkg = JSON.parse(packageJson.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Unreadable('package.json is not valid JSON');
  }
  const scripts = isObject(pkg) && isObject(pkg.scripts) ? pkg.scripts : {};
  return Object.fromEntries(
    INSTALL_HOOKS.flatMap((h) => {
      const script = Object.hasOwn(scripts, h) ? str(scripts[h]) : undefined;
      return script ? [[h, script]] : [];
    }),
  );
}

/**
 * Reads a tar stream piece by piece, in the forms npm, pnpm, yarn and bun
 * write, as node-tar 6 and 7 both read them (DESIGN.md, Decisions): headers
 * with a valid checksum; files (`0`), folders (`5`, no body) and links (`1`,
 * `2`, which npm leaves out), each with a path of a first folder and plain
 * parts; and before an entry, PAX headers (`x`) and GNU long names (`L`, `K`)
 * under 1 MiB. Anything node-tar reads leniently, or node-tar 6 and 7 read
 * differently, is not read. It keeps the root package.json and notes a root
 * binding.gyp, the names npm strips the first folder to.
 */
class TarScanner {
  private packageJson?: Buffer;
  private bindingGyp = false;
  private pending: Buffer = Buffer.alloc(0);
  private unpacked = 0;
  private ended = false;
  /** The entry whose body comes next: its bytes left, the padding after it, and what to keep. */
  private entry?: { left: number; pad: number; keep?: Buffer[]; done: (body: Buffer) => void };
  /** What PAX headers and GNU long names gave the next entry, merged in order as node-tar does. */
  private meta?: Meta;

  constructor(private readonly limits: typeof LIMITS) {}

  write(chunk: Buffer): void {
    this.unpacked += chunk.length;
    if (this.unpacked > this.limits.unpackedBytes) {
      throw new Unreadable(`over ${MB(this.limits.unpackedBytes)} unpacked`);
    }
    if (this.ended) {
      // node-tar reads on after one zero block; only zeros may follow it here.
      if (chunk.some((b) => b !== 0)) throw new Unreadable('tar: data after a zero block');
      return;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.entry) {
        const { entry } = this;
        const n = Math.min(entry.left, this.pending.length);
        entry.keep?.push(this.pending.subarray(0, n));
        entry.left -= n;
        this.pending = this.pending.subarray(n);
        if (entry.left > 0) return;
        if (this.pending.length < entry.pad) return;
        this.pending = this.pending.subarray(entry.pad);
        this.entry = undefined;
        entry.done(Buffer.concat(entry.keep ?? []));
        continue;
      }
      if (this.pending.length < 512) return;
      const header = this.pending.subarray(0, 512);
      this.pending = this.pending.subarray(512);
      if (header.every((b) => b === 0)) {
        this.ended = true;
        if (this.pending.some((b) => b !== 0)) throw new Unreadable('tar: data after a zero block');
        return;
      }
      this.header(header);
    }
  }

  /** npm reads an archive that ends after its last entry, without the zero blocks; not inside one. */
  end(): void {
    if (this.entry || (!this.ended && this.pending.length)) {
      throw new Unreadable('tar: ends inside an entry');
    }
  }

  tarball(): Tarball {
    return { scripts: packageJsonHooks(this.packageJson), bindingGyp: this.bindingGyp };
  }

  private header(header: Buffer): void {
    // A text field as node-tar reads it: up to a NUL, and on after a line
    // break that follows one.
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*/, '');
    // Every header carries a checksum; node-tar skips a header with a wrong one.
    const sum = header.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
    if (octal(header, 148) !== sum) throw new Unreadable('tar: bad header');
    const size = octal(header, 124);
    if (size === undefined) throw new Unreadable('tar: size not in octal');
    const type = String.fromCharCode(header[156]!);
    const linkname = field(157, 100);
    const hasLinkName = header.subarray(157, 257).some((b) => b !== 0);
    // The header's own path as node-tar reads it: the name, with the prefix
    // under the magic `ustar\0` `00`, joined on even when empty if byte 475 is
    // set.
    let ownPath = field(0, 100);
    if (header.subarray(257, 265).toString('latin1') === 'ustar\u000000') {
      const prefix = header[475] !== 0 ? field(345, 155) : field(345, 130);
      if (header[475] !== 0 || prefix) ownPath = `${prefix}/${ownPath}`;
    }
    const pad = (512 - (size % 512)) % 512;

    if (type === 'x' || type === 'L' || type === 'K') {
      // node-tar skips a meta header without a path of its own (node-tar 6
      // would take a pending PAX path for one), and node-tar 6 one with a link
      // name, which node-tar 7 reads in a PAX header. node-tar 6 also gives a
      // pending PAX size to the next header even when that is a meta header,
      // which node-tar 7 does not.
      if (!ownPath) throw new Unreadable('tar: a meta header without a path');
      if (hasLinkName) throw new Unreadable('tar: a link name on a meta header');
      if (this.meta?.size !== undefined) {
        throw new Unreadable('tar: a meta header after a PAX size');
      }
      if (size > MAX_META) throw new Unreadable('tar: a meta header over 1 MiB');
      // node-tar does nothing with an empty one.
      const done = (body: Buffer) => {
        if (size) this.meta = { ...this.meta, ...metaOf(type, body) };
      };
      this.entry = { left: size, pad, keep: [], done };
      return;
    }
    const meta = this.meta;
    this.meta = undefined;
    // node-tar takes a PAX size over the header's.
    if (meta?.size !== undefined && meta.size !== size) {
      throw new Unreadable('tar: a PAX size that differs from the header');
    }
    // A PAX or GNU long name comes before the header's own path.
    const path = meta?.path ?? ownPath;
    // node-tar skips a header without a path, a link without a target in its
    // own header, and a file or folder with one, keeping what PAX headers and
    // long names gave for the entry after it.
    if (!path) throw new Unreadable('tar: an entry without a path');
    if (type === '1' || type === '2') {
      if (!linkname) throw new Unreadable('tar: a link without a target');
      // npm leaves links out (pacote).
      this.entry = { left: size, pad, done: () => undefined };
      return;
    }
    if (hasLinkName) throw new Unreadable('tar: a link name on a file or folder');
    if (type !== '0' && type !== '5')
      throw new Unreadable(`tar: entry type ${JSON.stringify(type)}`);
    if (type === '5' && size !== 0) throw new Unreadable('tar: a folder with a size');
    const file = rootName(path, type === '5');

    const target = file === undefined ? undefined : sameFileAs(file);
    if (target) {
      if (file !== target) throw new Unreadable(`${path}: another name for ${target}`);
      // npm runs node-gyp only for a binding.gyp that is a file (@npmcli/node-gyp).
      if (target === 'binding.gyp') this.bindingGyp ||= type === '0';
      else if (type !== '0') throw new Unreadable('package.json is not a file');
      else if (this.packageJson) throw new Unreadable('package.json twice');
      else {
        if (size > this.limits.fileBytes) {
          throw new Unreadable(`a package.json over ${MB(this.limits.fileBytes)}`);
        }
        this.entry = { left: size, pad, keep: [], done: (body) => (this.packageJson = body) };
        return;
      }
    }
    this.entry = { left: size, pad, done: () => undefined };
  }
}

/**
 * Which of the root names npm reads a name could be written as, on a file
 * system that does not tell them apart: one that ignores case or Unicode
 * form (macOS, Windows), drops a trailing dot or space (Windows), or knows a
 * file by a short name such as `PACKAG~1.JSO` (Windows). Only these known
 * ways are covered (DESIGN.md, Known limitations).
 */
function sameFileAs(name: string): 'package.json' | 'binding.gyp' | undefined {
  const folded = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[. ]+$/, '');
  if (folded === 'package.json' || folded === 'binding.gyp') return folded;
  // A short name keeps the first three letters of the extension.
  if (/^[^.]{1,8}~[0-9]+\.(jso|gyp)$/.test(folded)) {
    throw new Unreadable(`${name}: may be a short name for another file`);
  }
  return undefined;
}

/**
 * A number field as node-tar reads it, 12 bytes from `at` up to a NUL,
 * trimmed, in octal (so the checksum's 8-byte field runs into the type); only
 * when that is all octal digits.
 */
function octal(header: Buffer, at: number): number | undefined {
  const text = header
    .subarray(at, at + 12)
    .toString('utf8')
    .replace(/\0.*$/s, '')
    .trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : undefined;
}

/**
 * The name a path has at the package root once npm strips its first folder,
 * if it is there. The path is a first folder and plain parts: none empty,
 * `.` or `..`, and no `\`; a folder may end in `/`, a file may not.
 */
function rootName(path: string, folder: boolean): string | undefined {
  const parts = (folder && path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\\'))) {
    throw new Unreadable(`tar: path ${JSON.stringify(path)}`);
  }
  if (parts.length < 2 && !folder) throw new Unreadable(`tar: a file outside a folder: ${path}`);
  return parts.length === 2 ? parts[1] : undefined;
}

/** What PAX headers and GNU long names give the entry after them that bumpvet uses. */
interface Meta {
  path?: string;
  size?: number;
}

/**
 * What a meta header's body gives the next entry. A GNU long name (`L`) is its
 * body up to a NUL, cut as node-tar cuts it; a long link name (`K`) gives
 * nothing bumpvet uses. A PAX header's records
 * are `<length> <key>=<value>\n`; node-tar splits them at line breaks and
 * bumpvet by length, so a value with a line break, a length that does not
 * match, a `size` that is not a number, or a `path` node-tar would read as a
 * number, is not read.
 */
function metaOf(type: 'x' | 'L' | 'K', body: Buffer): Meta {
  if (type === 'L') return { path: body.toString('utf8').replace(/\0.*/, '') };
  if (type === 'K') return {};
  const meta: Meta = {};
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const space = body.indexOf(0x20, at);
    // node-tar cuts the length off by its digits: no leading zeros.
    const digits = body.subarray(at, space).toString('latin1');
    const length = Number(digits);
    if (space < 0 || !/^[1-9][0-9]*$/.test(digits) || at + length > body.length) {
      throw new Unreadable('tar: bad PAX record');
    }
    const record = body.subarray(space + 1, at + length).toString('utf8');
    const eq = record.indexOf('=');
    if (!record.endsWith('\n') || record.indexOf('\n') !== record.length - 1 || eq < 0) {
      throw new Unreadable('tar: bad PAX record');
    }
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1, -1);
    if (key === 'path') {
      if (/^[0-9]+$/.test(value)) throw new Unreadable('tar: a PAX path of digits');
      meta.path = value;
    } else if (key === 'size') {
      if (!/^[0-9]+$/.test(value)) throw new Unreadable('tar: a PAX size not a number');
      meta.size = Number(value);
    }
    at += length;
  }
  if (body.subarray(at).some((b) => b !== 0)) throw new Unreadable('tar: bad PAX record');
  return meta;
}
