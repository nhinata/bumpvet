/**
 * Content groundwork (issue #44), benign side: for the same updates `npm run
 * eval` replays, counts which kinds of code each release added. Tarballs are
 * downloaded, checked against the registry's integrity, read in memory and
 * dropped; nothing is kept on disk.
 *
 *   npm run eval:content [-- --per-package 10]
 */
import {
  added,
  fetchTarball,
  PATTERNS,
  NEW_URL_HOST,
  readTarball,
  scan,
  type Scan,
} from './content.js';
import { PACKAGES, load, updates } from './updates.js';

const KINDS = [...Object.keys(PATTERNS), NEW_URL_HOST];

interface Row {
  update: string;
  kinds: string[];
}
const rows: Row[] = [];
const failed: string[] = [];
let tooLarge = 0;

async function vetPackage(name: string): Promise<void> {
  let p;
  try {
    p = await load(name);
  } catch (err) {
    failed.push(`${name}: ${(err as Error).message}`);
    return;
  }
  const scans = new Map<string, Promise<Scan>>();
  const scanOf = (version: string) => {
    let s = scans.get(version);
    if (!s) {
      s = fetchTarball(p.versions[version]?.dist).then((tgz) => {
        const result = scan(readTarball(tgz));
        tooLarge += result.tooLarge;
        return result;
      });
      scans.set(version, s);
    }
    return s;
  };
  for (const { from, to } of updates(p)) {
    const update = `${name} ${from} -> ${to}`;
    try {
      rows.push({ update, kinds: added(await scanOf(from), await scanOf(to)) });
    } catch (err) {
      failed.push(`${update}: ${(err as Error).message}`);
    }
  }
}

// A few packages at a time: each holds at most two tarballs in memory at once.
const queue = [...PACKAGES];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) await vetPackage(name);
  }),
);

console.log(`## Benign updates: ${rows.length} updates of ${PACKAGES.length} packages\n`);
console.log('| Kind added | Updates | Share | Examples |');
console.log('| --- | --- | --- | --- |');
for (const kind of KINDS) {
  const hits = rows.filter((r) => r.kinds.includes(kind));
  const share = rows.length ? ((100 * hits.length) / rows.length).toFixed(1) : '0.0';
  const examples = hits
    .slice(0, 3)
    .map((r) => r.update)
    .join('; ');
  console.log(`| \`${kind}\` | ${hits.length} | ${share}% | ${examples} |`);
}
console.log(`\nFiles over the size limit, left unread: ${tooLarge}`);
if (failed.length)
  console.log(`\nNot measured (${failed.length}):\n${failed.map((f) => `- ${f}`).join('\n')}`);
