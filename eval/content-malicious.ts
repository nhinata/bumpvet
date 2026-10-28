/**
 * Content groundwork (issue #44), malicious side: which kinds of code real
 * malicious releases added, from the Datadog dataset samples listed in
 * samples.json (see samples-build.ts). Runs only in
 * .github/workflows/eval-content.yml, in three steps:
 *
 *   fetch <dir>             on the runner: the encrypted sample ZIPs (checked
 *                           against their git blob hashes) and the tarballs
 *                           they are compared with (checked against the registry)
 *   scan <dir> <work> <id>  in a container without network, after the workflow
 *                           has unzipped sample <id> to <work>: one JSON line
 *   report <results>        on the runner: the tables, from the JSON lines
 *
 * Only kinds of code and counts are printed, never the code itself.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slim } from '../src/registry.js';
import { computeSignals } from '../src/signals.js';
import {
  added,
  fetchTarball,
  NEW_URL_HOST,
  PATTERNS,
  readDirectory,
  readTarball,
  scan,
} from './content.js';
import { load } from './updates.js';

interface Sample {
  id: string;
  name: string;
  from: string;
  to: string;
  /** A sample of an incident in test/incidents.test.ts, where its verdict is. */
  incident?: boolean;
  zip: string;
  blob: string;
}
interface Result {
  id: string;
  error?: string;
  kinds?: string[];
  /** An install script was added or changed, as bumpvet's install-scripts signal reads it. */
  installScripts?: boolean;
  files?: string;
}
const { dataset, samples } = JSON.parse(
  readFileSync(new URL('../../eval/samples.json', import.meta.url), 'utf8'),
) as { dataset: { repo: string; commit: string }; samples: Sample[] };
const INSTALL_SCRIPTS = 'install-scripts';

/** The package.json nearest the root. */
function manifest(files: Map<string, Buffer>): unknown {
  const path = [...files.keys()]
    .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!path) throw new Error('no package.json');
  return JSON.parse(files.get(path)!.toString('utf8'));
}

/**
 * Whether bumpvet's install-scripts signal fires from one package.json to the
 * other, by its own code. bumpvet reads the registry's manifest, which for a
 * removed release is gone; the tarball's package.json stands in for it.
 */
function installScripts(s: Sample, prev: unknown, next: unknown): boolean {
  const time = { [s.from]: '2000-01-01T00:00:00Z', [s.to]: '2000-01-02T00:00:00Z' };
  const p = slim({ name: s.name, time, versions: { [s.from]: prev, [s.to]: next } }, s.name);
  const change = { name: s.name, from: s.from, to: s.to };
  return computeSignals(change, p, { now: new Date(time[s.to]!) }).some(
    (signal) => signal.id === 'install-scripts',
  );
}

async function fetchAll(dir: string): Promise<void> {
  mkdirSync(join(dir, 'zips'), { recursive: true });
  mkdirSync(join(dir, 'prev'), { recursive: true });
  const queue = [...samples];
  const one = async (s: Sample) => {
    const res = await fetch(
      `https://raw.githubusercontent.com/${dataset.repo}/${dataset.commit}/${s.zip}`,
      { signal: AbortSignal.timeout(300_000) },
    );
    if (!res.ok) {
      // Reported by scan as not measured; a hash that does not match stops the run.
      console.error(`${s.zip}: ${res.status}`);
      return;
    }
    const zip = Buffer.from(await res.arrayBuffer());
    // The hash git gives the file at that commit, as samples-build.ts listed it.
    const blob = createHash('sha1').update(`blob ${zip.length}\0`).update(zip).digest('hex');
    if (blob !== s.blob) throw new Error(`${s.zip}: hash does not match samples.json`);
    writeFileSync(join(dir, 'zips', `${s.id}.zip`), zip);
    try {
      const tgz = await fetchTarball((await load(s.name)).versions[s.from]?.dist);
      writeFileSync(join(dir, 'prev', `${s.id}.tgz`), tgz);
    } catch (err) {
      // Reported by scan as not measured.
      console.error(`${s.name}@${s.from}: ${(err as Error).message}`);
    }
  };
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await one(s);
    }),
  );
}

function scanOne(dir: string, work: string, id: string): Result {
  const prevPath = join(dir, 'prev', `${id}.tgz`);
  if (!existsSync(prevPath)) return { id, error: 'previous version not fetched' };
  const prevFiles = readTarball(readFileSync(prevPath));
  // A sample is the package's files, or the tarball itself.
  let files = readDirectory(work);
  const tarballs = [...files.keys()].filter((f) => /\.(?:tgz|tar\.gz)$/.test(f));
  if (tarballs.length === 1) files = readTarball(files.get(tarballs[0]!)!);
  const prev = scan(prevFiles);
  const next = scan(files);
  // Reading no code would look like adding nothing.
  if (!next.files) return { id, error: 'no code read' };
  const sample = samples.find((x) => x.id === id)!;
  return {
    id,
    kinds: added(prev, next),
    installScripts: installScripts(sample, manifest(prevFiles), manifest(files)),
    files: `${prev.files} -> ${next.files}${next.tooLarge ? ` (${next.tooLarge} too large)` : ''}`,
  };
}

function report(resultsPath: string): void {
  const byId = new Map<string, Result>(
    readFileSync(resultsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Result)
      .map((r) => [r.id, r]),
  );
  const measured = samples.flatMap((s) => {
    const r = byId.get(s.id);
    return r?.kinds
      ? [{ s, r, kinds: r.installScripts ? [INSTALL_SCRIPTS, ...r.kinds] : r.kinds }]
      : [];
  });
  const notMeasured = samples.filter((s) => !byId.get(s.id)?.kinds);
  const withoutScripts = measured.filter((m) => !m.r.installScripts);
  const month = (s: Sample) => s.zip.split('/').at(-1)!.slice(0, 7);
  const count = (set: typeof measured, kind: string) =>
    set.filter((m) => m.kinds.includes(kind)).length;
  const KINDS = [INSTALL_SCRIPTS, ...Object.keys(PATTERNS), NEW_URL_HOST];

  console.log(`## Malicious releases: ${measured.length} measured of ${samples.length}\n`);
  console.log(`Without an install-script change: ${withoutScripts.length}.\n`);
  console.log('| Kind added | Samples | Without an install-script change |');
  console.log('| --- | --- | --- |');
  for (const kind of KINDS)
    console.log(
      `| \`${kind}\` | ${count(measured, kind)} | ${kind === INSTALL_SCRIPTS ? '' : count(withoutScripts, kind)} |`,
    );

  console.log('\n### By month the dataset found them\n');
  console.log('| Month | Samples | Kinds added (samples) |');
  console.log('| --- | --- | --- |');
  for (const m of [...new Set(measured.map((x) => month(x.s)))].sort()) {
    const set = measured.filter((x) => month(x.s) === m);
    const cells = KINDS.map((k) => [k, count(set, k)] as const)
      .filter(([, n]) => n)
      .map(([k, n]) => `\`${k}\` ${n}`)
      .join(', ');
    console.log(`| ${m} | ${set.length} | ${cells} |`);
  }

  console.log('\n### Incidents from test/incidents.test.ts\n');
  console.log('| Release | Kinds added | Code files read |');
  console.log('| --- | --- | --- |');
  for (const s of samples.filter((x) => x.incident)) {
    const r = byId.get(s.id);
    const m = measured.find((x) => x.s === s);
    const kinds = m
      ? m.kinds.map((k) => `\`${k}\``).join(', ') || 'none'
      : `**${r?.error ?? 'not scanned'}**`;
    console.log(`| ${s.name} ${s.from} -> ${s.to} | ${kinds} | ${r?.files ?? ''} |`);
  }

  if (notMeasured.length) {
    console.log(`\nNot measured (${notMeasured.length}):\n`);
    for (const s of notMeasured)
      console.log(`- ${s.name}@${s.to}: ${byId.get(s.id)?.error ?? 'not scanned'}`);
  }
}

const [mode, a, b, c] = process.argv.slice(2);
if (mode === 'fetch' && a) await fetchAll(a);
else if (mode === 'scan' && a && b && c) {
  let result: Result;
  try {
    result = scanOne(a, b, c);
  } catch (err) {
    // Some messages quote what they failed on (JSON.parse does), which here is
    // the sample: keep only short ones that quote nothing.
    const { name, message } = err as Error;
    result = { id: c, error: message.length <= 80 && !/["'`]/.test(message) ? message : name };
  }
  console.log(JSON.stringify(result));
} else if (mode === 'report' && a) report(a);
else {
  console.error('usage: content-malicious fetch <dir> | scan <dir> <work> <id> | report <results>');
  process.exit(2);
}
