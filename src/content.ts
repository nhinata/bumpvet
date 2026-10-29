import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { messageWithCause } from './errors.js';
import type { VersionManifest } from './types.js';

/**
 * Kinds of code each content signal looks for, each found by a pattern in a
 * file's text. Chosen by the measurement in DESIGN.md (Content signals).
 */
export const KINDS = {
  'hidden-code': {
    'obfuscated-names': /\b_0x[0-9a-f]{4,}\b/,
    // Each starts only where a run starts and checks a fixed length, so a long
    // run is neither searched again from every character nor matched to its end.
    'hex-escapes': /(?<!\\x[0-9a-fA-F]{2})(?:\\x[0-9a-fA-F]{2}){16}/,
    'long-base64': /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{1000}/,
    // Code pushed out of sight, past the edge of a viewer, by a long run of
    // spaces after other code or at the start of a line.
    'hidden-after-whitespace': /(?:^|\S)[ \t]{200}(?=[ \t]*\S)/m,
  },
  'new-capability': {
    eval: /(?<![.\w$])eval\s*\(/,
    'node-network':
      // One run of spaces per branch: `\s*\(?\s*` would try every split of a long run.
      /\b(?:require\s*\(\s*|from\s*|import\s*(?:\(\s*)?)['"](?:node:)?(?:https?|http2|net|tls|dgram|dns)['"]/,
  },
} as const;

/** What a release's files are read within (see DESIGN.md). */
export const LIMITS = {
  downloadBytes: 256_000_000,
  unpackedBytes: 512_000_000,
  files: 100_000,
  fileBytes: 128_000_000,
};
const MB = (n: number) => `${n / 1_000_000} MB`;

/**
 * Each kind found in a release, with the first file it was found in; or why
 * the files were not read.
 */
export type Content = { found: Map<string, string> } | { unread: string };

/** Reads a version's files. Throws only when the registry cannot be reached. */
export type ReadContent = (version: VersionManifest, signal?: AbortSignal) => Promise<Content>;

/** A release bumpvet does not read: over a limit, or in a form it does not understand. */
class Unreadable extends Error {}

/** Kinds found in `files`, each with the first path (in tarball order) it is in. */
export function kindsIn(files: Iterable<[string, Buffer]>): Map<string, string> {
  const found = new Map<string, string>();
  const all = Object.values(KINDS).reduce((n, patterns) => n + Object.keys(patterns).length, 0);
  for (const [path, data] of files) {
    if (found.size === all) break;
    const text = data.toString('utf8');
    for (const patterns of Object.values(KINDS))
      for (const [kind, re] of Object.entries(patterns))
        if (!found.has(kind) && re.test(text)) found.set(kind, path);
  }
  return found;
}

/**
 * The regular files of an npm tarball (gzipped or not), by path with the
 * leading `package/` removed. Links are left out, as npm leaves them out when
 * it installs. Throws Unreadable over a limit, or for a form it does not read.
 */
export function readTarball(tgz: Buffer, limits = LIMITS): [string, Buffer][] {
  let tar: Buffer;
  if (tgz[0] === 0x1f && tgz[1] === 0x8b) {
    try {
      // A bound on the unpacked size, so an archive that inflates without end fails
      // here instead of taking all memory.
      tar = gunzipSync(tgz, { maxOutputLength: limits.unpackedBytes });
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
        throw new Unreadable(`over ${MB(limits.unpackedBytes)} unpacked`);
      throw new Unreadable('not a gzip file npm can read');
    }
  } else tar = tgz;

  const files: [string, Buffer][] = [];
  let longName: string | undefined;
  for (let at = 0; ;) {
    // npm reads an archive that ends after its last entry, without the zero blocks.
    if (at === tar.length) break;
    if (at + 512 > tar.length) throw new Unreadable('tar: ends inside a header');
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    // Every header carries a checksum; a wrong one is not a tar header.
    const sum = header.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
    if (parseInt(field(148, 8).trim(), 8) !== sum) throw new Unreadable('tar: bad header');
    const sizeField = field(124, 12).trim();
    // A size in base 256 (first byte 0x80) is for files of 8 GB and more.
    if (!/^[0-7]*$/.test(sizeField)) throw new Unreadable('tar: size not in octal');
    const size = parseInt(sizeField || '0', 8);
    const type = String.fromCharCode(header[156]!);
    const body = tar.subarray(at + 512, at + 512 + size);
    if (body.length < size) throw new Unreadable('tar: an entry ends early');
    at += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      const pax = paxRecords(body);
      // A size given here would override the header's; npm does not write one.
      if (pax.has('size')) throw new Unreadable('tar: PAX size is not supported');
      if (type === 'g' && pax.has('path')) throw new Unreadable('tar: global PAX path');
      longName = pax.get('path') ?? longName;
      continue;
    }
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    if (type === '0' || type === '\0' || type === '7') {
      if (size > limits.fileBytes) throw new Unreadable(`a file over ${MB(limits.fileBytes)}`);
      if (files.length >= limits.files) throw new Unreadable(`over ${limits.files} files`);
      files.push([name.replace(/^[^/]+\//, ''), body]);
    } else if (!'125K'.includes(type)) {
      // Links (1, 2, K), directories (5); anything else is not something npm writes.
      throw new Unreadable(`tar: entry type ${JSON.stringify(type)}`);
    }
  }
  return files;
}

/** PAX records: `<length> <key>=<value>\n`, each length counting the whole record. */
function paxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  for (let at = 0; at < body.length && body[at] !== 0;) {
    const space = body.indexOf(0x20, at);
    const length = Number(body.subarray(at, space).toString('latin1'));
    if (space < 0 || !Number.isInteger(length) || length <= space - at || at + length > body.length)
      throw new Unreadable('tar: bad PAX record');
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq < 0) throw new Unreadable('tar: bad PAX record');
    records.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return records;
}

/**
 * Reads releases from the registry: the tarball its manifest names, checked
 * against the registry's hash, read in memory and never run. Each tarball is
 * read once per run, and at most `concurrency` at a time, since one can take
 * hundreds of megabytes while it is read.
 */
export function registryContent(
  fetchImpl: typeof fetch = fetch,
  limits = LIMITS,
  concurrency = 4,
): ReadContent {
  const cache = new Map<string, Promise<Content>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const turn = async () => {
    if (running < concurrency) running++;
    // A finished read hands its turn over without giving it up in between.
    else await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const done = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  return (m, signal) => {
    const url = m.dist?.tarball;
    if (!url) return Promise.resolve({ unread: 'no tarball URL in the registry' });
    // With the hashes: a manifest that shares the URL but not the hash is checked on its own.
    const key = `${url} ${m.dist?.integrity} ${m.dist?.shasum}`;
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        // Declared by whoever published it, so only a reason to skip the download;
        // the limits below still hold when it is too low.
        const declared = m.dist?.unpackedSize;
        if (declared !== undefined && declared > limits.unpackedBytes)
          return { unread: `over ${MB(limits.unpackedBytes)} unpacked` };
        if (m.dist?.fileCount !== undefined && m.dist.fileCount > limits.files)
          return { unread: `over ${limits.files} files` };
        await turn();
        try {
          const tgz = await download(fetchImpl, url, m, limits, signal);
          if (!tgz) return { unread: `over ${MB(limits.downloadBytes)} to download` };
          return { found: kindsIn(readTarball(tgz, limits)) };
        } catch (err) {
          if (err instanceof Unreadable) return { unread: err.message };
          throw err;
        } finally {
          done();
        }
      })();
      cache.set(key, p);
    }
    return p;
  };
}

/** The tarball, checked against the registry's hash; undefined when over the download limit. */
async function download(
  fetchImpl: typeof fetch,
  url: string,
  m: VersionManifest,
  limits: typeof LIMITS,
  signal: AbortSignal | undefined,
): Promise<Buffer | undefined> {
  const name = `${m.version} (${url})`;
  // sha512 where the registry has it; versions from before 2017 have only sha1.
  const sha512 = m.dist?.integrity?.split(/\s+/).find((h) => h.startsWith('sha512-'));
  const sha1 = m.dist?.shasum && /^[0-9a-f]{40}$/i.test(m.dist.shasum) ? m.dist.shasum : undefined;
  if (!sha512 && !sha1) throw new Unreadable('no sha512 or sha1 hash in the registry');
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(300_000);
    res = await fetchImpl(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  } catch (err) {
    throw new Error(`fetching the tarball of ${name} failed: ${messageWithCause(err)}`, {
      cause: err,
    });
  }
  if (!res.ok) throw new Error(`registry returned ${res.status} for the tarball of ${name}`);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    // Leaving the loop early cancels the download.
    for await (const chunk of res.body ?? []) {
      length += chunk.length;
      if (length > limits.downloadBytes) return undefined;
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    throw new Error(`reading the tarball of ${name} failed: ${messageWithCause(err)}`, {
      cause: err,
    });
  }
  const data = Buffer.concat(chunks);
  const ok = sha512
    ? sha512 === `sha512-${createHash('sha512').update(data).digest('base64')}`
    : sha1!.toLowerCase() === createHash('sha1').update(data).digest('hex');
  if (!ok) throw new Error(`the tarball of ${name} does not match the registry's hash`);
  return data;
}
