/**
 * Reading the malicious samples for content-malicious.ts. The kinds of code,
 * the limits and how a tarball is read are bumpvet's own (src/content.ts).
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { admitFile } from '../src/content.js';

/**
 * Every regular file under `dir`, by path relative to it with a leading
 * `package/` removed, within bumpvet's limits (throws Unreadable over one).
 * Symbolic links are not followed.
 */
export function readDirectory(dir: string): [string, Buffer][] {
  const files: [string, Buffer][] = [];
  let unpacked = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        admitFile(files.length, unpacked, stat.size);
        unpacked += stat.size;
        files.push([relative(dir, path).replace(/^package\//, ''), readFileSync(path)]);
      }
    }
  };
  walk(dir);
  return files;
}
