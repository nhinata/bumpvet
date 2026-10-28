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
  CANDIDATE_SETS,
  caught,
  fetchTarball,
  PATTERNS,
  NEW_URL_HOST,
  readTarball,
  scan,
  SCOPES,
  type Scan,
  type Scope,
} from './content.js';
import { PACKAGES, load, updates } from './updates.js';

const KINDS = [...Object.keys(PATTERNS), NEW_URL_HOST];

interface Row {
  update: string;
  kinds: Record<Scope, string[]>;
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
      const [prev, next] = [await scanOf(from), await scanOf(to)];
      rows.push({
        update,
        kinds: { code: added(prev, next, 'code'), all: added(prev, next, 'all') },
      });
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

const share = (n: number) => (rows.length ? ((100 * n) / rows.length).toFixed(1) : '0.0');
console.log(`## Benign updates: ${rows.length} updates of ${PACKAGES.length} packages\n`);
console.log('| Kind added | Updates (code files) | Updates (all files) | Examples (all files) |');
console.log('| --- | --- | --- | --- |');
for (const kind of KINDS) {
  const [code, all] = SCOPES.map((s) => rows.filter((r) => r.kinds[s].includes(kind)));
  const examples = all!
    .slice(0, 3)
    .map((r) => r.update)
    .join('; ');
  console.log(
    `| \`${kind}\` | ${code!.length} (${share(code!.length)}%) | ${all!.length} (${share(all!.length)}%) | ${examples} |`,
  );
}

console.log('\n### Candidate sets: updates that add any kind in the set\n');
console.log('| Set | Updates (code files) | Updates (all files) | Examples (all files) |');
console.log('| --- | --- | --- | --- |');
for (const [name, set] of Object.entries(CANDIDATE_SETS)) {
  const [code, all] = SCOPES.map((s) => rows.filter((r) => caught(r.kinds[s], set)));
  const examples = all!
    .slice(0, 5)
    .map((r) => r.update)
    .join('; ');
  console.log(`| ${name} | ${code!.length} | ${all!.length} | ${examples} |`);
}
console.log(`\nFiles over the size limit, left unread: ${tooLarge}`);
if (failed.length)
  console.log(`\nNot measured (${failed.length}):\n${failed.map((f) => `- ${f}`).join('\n')}`);
