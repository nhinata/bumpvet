/**
 * Groundwork for content signals (issue #44): which kinds of code a release
 * adds compared with the version it upgrades from. Nothing here is run; files
 * are read as text.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Candidate kinds of code, each found by a pattern in the file's text. */
export const PATTERNS: Record<string, RegExp> = {
  'child-process': /\bchild_process\b/,
  'node-network':
    /\b(?:require\s*\(\s*|from\s*|import\s*\(?\s*)['"](?:node:)?(?:https?|http2|net|tls|dgram|dns)['"]/,
  fetch: /\bfetch\s*\(/,
  xhr: /\bXMLHttpRequest\b/,
  websocket: /\bWebSocket\b/,
  'process-env': /\bprocess\.env\b/,
  eval: /(?<![.\w$])eval\s*\(/,
  'new-function': /\bnew\s+Function\s*\(/,
  'obfuscated-names': /\b_0x[0-9a-f]{4,}\b/,
  // Each starts only where a run starts and checks a fixed length, so a long
  // run is neither searched again from every character nor matched to its end.
  'hex-escapes': /(?<!\\x[0-9a-fA-F]{2})(?:\\x[0-9a-fA-F]{2}){16}/,
  'long-base64': /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{1000}/,
  'crypto-wallet': /\bwindow\.(?:ethereum|solana)\b|\bethereum\.request\b/,
  // Code pushed out of sight, past the edge of a viewer, by a long run of
  // spaces after other code or at the start of a line.
  'hidden-after-whitespace': /(?:^|\S)[ \t]{200}(?=[ \t]*\S)/m,
};
/** Not a pattern: a URL host in the code that the previous version's code did not have. */
export const NEW_URL_HOST = 'new-url-host';
const URL_HOST = /\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/**
 * Sets of kinds that could become content signals, each counted as one: a
 * release is caught when it adds any kind in the set. The first are the kinds
 * no benign update added in the first counts (2026-10-28).
 */
const QUIET = ['obfuscated-names', 'eval', 'long-base64', 'hex-escapes', 'node-network'];
export const CANDIDATE_SETS: Record<string, string[]> = {
  quiet: QUIET,
  'quiet + hidden': [...QUIET, 'hidden-after-whitespace'],
  'quiet + hidden + xhr + child-process': [
    ...QUIET,
    'hidden-after-whitespace',
    'xhr',
    'child-process',
  ],
};
export const caught = (kinds: string[], set: string[]) => set.some((k) => kinds.includes(k));

/**
 * Which files are read: code files only (`.js`, `.cjs`, `.mjs`), or every
 * file, since Node runs a required file whatever its extension.
 */
export const SCOPES = ['code', 'all'] as const;
export type Scope = (typeof SCOPES)[number];
const CODE = /\.(?:js|cjs|mjs)$/;
/** Larger files are left unread and counted, so a size limit can be chosen from the numbers. */
export const MAX_FILE_BYTES = 20_000_000;

interface Found {
  kinds: Set<string>;
  hosts: Set<string>;
  /** Files read, and files over the size limit left unread. */
  read: number;
  tooLarge: number;
}
export type Scan = Record<Scope, Found>;

export function scan(files: Map<string, Buffer>): Scan {
  const found = (): Found => ({ kinds: new Set(), hosts: new Set(), read: 0, tooLarge: 0 });
  const result: Scan = { code: found(), all: found() };
  for (const [path, data] of files) {
    const into = CODE.test(path) ? [result.code, result.all] : [result.all];
    if (data.length > MAX_FILE_BYTES) {
      for (const f of into) f.tooLarge++;
      continue;
    }
    // A file with a NUL byte is binary (an image, a font, a native addon): Node
    // cannot run it as JavaScript, and its bytes would only match by chance.
    if (data.subarray(0, 8192).includes(0)) continue;
    for (const f of into) f.read++;
    const text = data.toString('utf8');
    for (const [kind, re] of Object.entries(PATTERNS))
      if (re.test(text)) for (const f of into) f.kinds.add(kind);
    for (const m of text.matchAll(URL_HOST)) for (const f of into) f.hosts.add(m[1]!.toLowerCase());
  }
  return result;
}

/** Kinds in `next` that `prev` did not have anywhere, reading the files of `scope`. */
export function added(prev: Scan, next: Scan, scope: Scope): string[] {
  const [before, after] = [prev[scope], next[scope]];
  const kinds = [...after.kinds].filter((k) => !before.kinds.has(k));
  if ([...after.hosts].some((h) => !before.hosts.has(h))) kinds.push(NEW_URL_HOST);
  return kinds.sort();
}

/** The files of an npm tarball (.tgz), by path with the leading `package/` removed. */
export function readTarball(tgz: Buffer): Map<string, Buffer> {
  // A bound on the unpacked size, so an archive that inflates without end fails
  // here instead of taking all memory.
  const tar = gunzipSync(tgz, { maxOutputLength: 500_000_000 });
  const files = new Map<string, Buffer>();
  let longName: string | undefined;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156]!);
    const body = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x') {
      longName = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? longName;
      // A size given here would override the header's; npm does not write one.
      if (/\d+ size=/.test(body.toString('utf8')))
        throw new Error('tar: PAX size is not supported');
      continue;
    }
    // A long link name belongs to the next entry, which is not a file to read.
    if (type === 'K') continue;
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    if (type === '0' || type === '\0') files.set(name.replace(/^[^/]+\//, ''), body);
  }
  return files;
}

/**
 * Every regular file under `dir`, by path relative to it with a leading
 * `package/` removed. Symbolic links are not followed.
 */
export function readDirectory(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        files.set(relative(dir, path).replace(/^package\//, ''), readFileSync(path));
    }
  };
  walk(dir);
  return files;
}

/** Downloads a tarball and checks it against the registry's sha512 integrity. */
export async function fetchTarball(dist: { tarball?: string; integrity?: string } | undefined) {
  const want = dist?.integrity?.split(/\s+/).find((h) => h.startsWith('sha512-'));
  if (!dist?.tarball || !want)
    throw new Error('the registry gives no tarball with a sha512 integrity');
  const res = await fetch(dist.tarball, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${dist.tarball}: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const got = 'sha512-' + createHash('sha512').update(data).digest('base64');
  if (want !== got) throw new Error(`${dist.tarball}: integrity does not match`);
  return data;
}
