/**
 * Writes samples.json: the malicious releases the Evaluate content workflow
 * reads. They are the npm `compromised_lib` samples GuardDog's evaluation
 * picked from the Datadog dataset (one per cluster of similar code), plus the
 * incidents of test/incidents.test.ts that the dataset has. Each is paired
 * with the version it would upgrade from: the highest earlier version still
 * on npm. Reads metadata only; no sample is downloaded.
 *
 *   tsc -p tsconfig.json && node dist-eval/eval/samples-build.js
 */
import { writeFileSync } from 'node:fs';
import { load } from './updates.js';

const GUARDDOG = { repo: 'DataDog/guarddog', commit: 'a46949ddd7e164defe1a2ad78f7c8f6586c6667a' };
const PREFIX = 'samples/npm/compromised_lib/';
/** Incidents from test/incidents.test.ts in the dataset, with whether bumpvet missed them 1h after publish. */
const INCIDENTS: Record<string, boolean> = {
  'debug/4.4.2': true,
  'ansi-styles/6.2.2': true,
  '@solana@web3.js/1.95.7': true,
  '@ctrl@tinycolor/4.1.1': false,
  'ngx-bootstrap/20.0.5': false,
  'eslint-config-prettier/8.10.1': false,
  '@rspack@core/1.1.7': false,
};

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}
interface Picked {
  dataset_repo: string;
  dataset_sha: string;
  samples: { ecosystem: string; category: string; zip_path: string }[];
}
type Entry = { name: string; path: string; sha: string };

const picked = await json<Picked>(
  `https://raw.githubusercontent.com/${GUARDDOG.repo}/${GUARDDOG.commit}/evals/recall_samples.json`,
);
const dataset = { repo: picked.dataset_repo, commit: picked.dataset_sha };
// The dataset's file hashes at that commit, from one listing of the folder.
const npm = await json<Entry[]>(
  `https://api.github.com/repos/${dataset.repo}/contents/samples/npm?ref=${dataset.commit}`,
);
const folder = npm.find((e) => e.name === 'compromised_lib');
if (!folder) throw new Error('no compromised_lib folder');
const tree = await json<{ tree: Entry[] }>(
  `https://api.github.com/repos/${dataset.repo}/git/trees/${folder.sha}?recursive=1`,
);
const blobs = new Map<string, string>(tree.tree.map((e) => [PREFIX + e.path, e.sha]));

const zips = new Set<string>(
  picked.samples
    .filter((s) => s.ecosystem === 'npm' && s.category === 'compromised_lib')
    .map((s) => s.zip_path),
);
for (const key of Object.keys(INCIDENTS)) {
  const zip = [...blobs.keys()].find((p) => p.startsWith(PREFIX + key + '/'));
  if (!zip) throw new Error(`${key}: not in the dataset at ${dataset.commit}`);
  zips.add(zip);
}

const num = (v: string) => v.split('.').map(Number);
const below = (a: string, b: string) => {
  const [x, y] = [num(a), num(b)];
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};

const samples = [];
const skipped: string[] = [];
for (const zip of [...zips].sort()) {
  // {package with @ for /}/{version}/{file}.zip
  const [dir, to] = zip.slice(PREFIX.length).split('/');
  const name = dir!.startsWith('@') ? dir!.replace(/^(@[^@]+)@/, '$1/') : dir!;
  let from: string | undefined;
  try {
    const p = await load(name);
    const cutoff = p.time[to!];
    from = Object.keys(p.versions)
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && below(v, to!) < 0)
      .filter((v) => !cutoff || (p.time[v] ?? '') < cutoff)
      .sort(below)
      .at(-1);
  } catch (err) {
    skipped.push(`${name}@${to}: ${(err as Error).message}`);
    continue;
  }
  if (!from) {
    skipped.push(`${name}@${to}: no earlier version on npm`);
    continue;
  }
  const key = `${dir}/${to}`;
  samples.push({
    id: `${dir}-${to}`.replace(/[@/]/g, '_'),
    name,
    from,
    to,
    ...(key in INCIDENTS ? { missed: INCIDENTS[key] } : {}),
    zip,
    blob: blobs.get(zip),
  });
}

writeFileSync(
  new URL('../../eval/samples.json', import.meta.url),
  JSON.stringify({ dataset, picked: GUARDDOG, samples }, null, 2) + '\n',
);
console.log(`${samples.length} samples; skipped ${skipped.length}:`);
for (const s of skipped) console.log(`  ${s}`);
