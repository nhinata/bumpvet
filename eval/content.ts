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
    /\b(?:require\s*\(|from\s*|import\s*\(\s*)['"](?:node:)?(?:https?|net|tls|dgram|dns)['"]/,
  fetch: /\bfetch\s*\(/,
  xhr: /\bXMLHttpRequest\b/,
  websocket: /\bWebSocket\b/,
  'process-env': /\bprocess\.env\b/,
  eval: /(?<![.\w$])eval\s*\(/,
  'new-function': /\bnew\s+Function\s*\(/,
  'obfuscated-names': /\b_0x[0-9a-f]{4,}\b/,
  'hex-escapes': /(?:\\x[0-9a-fA-F]{2}){16,}/,
  'long-base64': /[A-Za-z0-9+/]{1000,}={0,2}/,
  'crypto-wallet': /\bwindow\.(?:ethereum|solana)\b|\bethereum\.request\b/,
};
/** Not a pattern: a URL host in the code that the previous version's code did not have. */
export const NEW_URL_HOST = 'new-url-host';
const URL_HOST = /\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

const CODE = /\.(?:js|cjs|mjs)$/;
/** Larger files are left unread and counted, so a size limit can be chosen from the numbers. */
export const MAX_FILE_BYTES = 20_000_000;

export interface Scan {
  kinds: Set<string>;
  hosts: Set<string>;
  files: number;
  tooLarge: number;
}

export function scan(files: Map<string, Buffer>): Scan {
  const result: Scan = { kinds: new Set(), hosts: new Set(), files: 0, tooLarge: 0 };
  for (const [path, data] of files) {
    if (!CODE.test(path)) continue;
    if (data.length > MAX_FILE_BYTES) {
      result.tooLarge++;
      continue;
    }
    result.files++;
    const text = data.toString('utf8');
    for (const [kind, re] of Object.entries(PATTERNS)) if (re.test(text)) result.kinds.add(kind);
    for (const m of text.matchAll(URL_HOST)) result.hosts.add(m[1]!.toLowerCase());
  }
  return result;
}

/** Kinds of code in `next` that `prev` did not have anywhere. */
export function added(prev: Scan, next: Scan): string[] {
  const kinds = [...next.kinds].filter((k) => !prev.kinds.has(k));
  if ([...next.hosts].some((h) => !prev.hosts.has(h))) kinds.push(NEW_URL_HOST);
  return kinds.sort();
}

/** The files of an npm tarball (.tgz), by path with the leading `package/` removed. */
export function readTarball(tgz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(tgz);
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
      continue;
    }
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
export async function fetchTarball(url: string, integrity: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const want = integrity.split(/\s+/).find((h) => h.startsWith('sha512-'));
  const got = 'sha512-' + createHash('sha512').update(data).digest('base64');
  if (!want || want !== got) throw new Error(`${url}: integrity does not match`);
  return data;
}
