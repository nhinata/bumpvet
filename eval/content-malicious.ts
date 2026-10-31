/**
 * Content signals on real malicious releases: which ones bumpvet's content
 * signals (and install-scripts) fire for, reading the files as bumpvet reads
 * them, from the Datadog dataset samples listed in samples.json (see
 * samples-build.ts). Runs only in
 * .github/workflows/eval-malicious.yml, in three steps:
 *
 *   fetch <dir>             on the runner: the encrypted sample ZIPs (checked
 *                           against their git blob hashes), and what bumpvet
 *                           reads from the version each one replaces
 *   scan <dir> <work> <id>  in a container without network, after the workflow
 *                           has unzipped sample <id> to <work>: one JSON line
 *   report <results>        on the runner: the tables, from the JSON lines
 *
 * Only signals and counts are printed, never the code itself. A removed
 * release's publisher and publish time are gone, so there is no verdict here;
 * test/incidents.test.ts has the verdicts of the incidents.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kindsIn, readTarball, registryContent, Unreadable } from '../src/content.js';
import { slim } from '../src/registry.js';
import { computeSignals, contentSignals, hasKinds } from '../src/signals.js';
import type { Content } from '../src/types/content.js';
import { SIGNALS, type Signal, type SignalId } from '../src/types/signals.js';
import { readDirectory } from './content.js';
import { load, pool } from './updates.js';

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
  /** The content signals and install-scripts, as bumpvet would report them. */
  signals?: SignalId[];
  /** install-scripts could not be told: no package.json read in the sample, or not valid JSON. */
  scriptsUnknown?: true;
  /** Files read in the sample. */
  files?: string;
}
const { dataset, samples } = JSON.parse(
  readFileSync(new URL('../../eval/samples.json', import.meta.url), 'utf8'),
) as { dataset: { repo: string; commit: string }; samples: Sample[] };
/** The package.json nearest the root, if there is one and it parses. */
function manifest(files: [string, Buffer][]): unknown {
  const [, data] =
    files
      .filter(([f]) => f === 'package.json' || f.endsWith('/package.json'))
      .sort(([a], [b]) => a.split('/').length - b.split('/').length)[0] ?? [];
  try {
    return data && JSON.parse(data.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Whether bumpvet's install-scripts signal fires from the registry's manifest
 * of the version replaced to the sample, by its own code. The registry's
 * manifest of the removed release is gone; its package.json stands in for it.
 */
function installScripts(s: Sample, prev: unknown, next: unknown): Signal[] {
  const time = { [s.from]: '2000-01-01T00:00:00Z', [s.to]: '2000-01-02T00:00:00Z' };
  const p = slim({ name: s.name, time, versions: { [s.from]: prev, [s.to]: next } }, s.name);
  const change = { name: s.name, from: s.from, to: s.to };
  return computeSignals(change, p, { now: new Date(time[s.to]!) }).filter(
    (signal) => signal.id === 'install-scripts',
  );
}

async function fetchAll(dir: string): Promise<void> {
  mkdirSync(join(dir, 'zips'), { recursive: true });
  mkdirSync(join(dir, 'prev'), { recursive: true });
  const readContent = registryContent();
  await pool(samples, 8, async (s) => {
    let zip: Buffer;
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${dataset.repo}/${dataset.commit}/${s.zip}`,
        { signal: AbortSignal.timeout(300_000) },
      );
      if (!res.ok) throw new Error(String(res.status));
      zip = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // Reported by scan as not measured; a hash that does not match stops the run.
      console.error(`${s.zip}: ${(err as Error).message}`);
      return;
    }
    // The hash git gives the file at that commit, as samples-build.ts listed it.
    const blob = createHash('sha1').update(`blob ${zip.length}\0`).update(zip).digest('hex');
    if (blob !== s.blob) throw new Error(`${s.zip}: hash does not match samples.json`);
    writeFileSync(join(dir, 'zips', `${s.id}.zip`), zip);
    // The version replaced, as bumpvet reads it: its manifest, and the kinds of
    // code in its files or why they were not read.
    try {
      const m = (await load(s.name)).versions[s.from];
      if (!m) throw new Error('not in the registry');
      const prev = join(dir, 'prev', s.id);
      const c = await readContent(m);
      writeFileSync(
        `${prev}.content.json`,
        JSON.stringify('found' in c ? { found: [...c.found] } : c),
      );
      writeFileSync(`${prev}.json`, JSON.stringify(m));
    } catch (err) {
      // Reported by scan as not measured.
      console.error(`${s.name}@${s.from}: ${(err as Error).message}`);
    }
  });
}

/** The files, or why bumpvet would not read them; other errors are thrown. */
function attempt(read: () => [string, Buffer][]): [string, Buffer][] | string {
  try {
    return read();
  } catch (err) {
    if (err instanceof Unreadable) return err.message;
    throw err;
  }
}

function scanOne(dir: string, work: string, id: string): Result {
  const prev = join(dir, 'prev', id);
  // Written last by fetch, so its presence means the version replaced was fetched.
  if (!existsSync(`${prev}.json`)) return { id, error: 'previous version not fetched' };
  const saved = JSON.parse(readFileSync(`${prev}.content.json`, 'utf8')) as
    { found: [string, string][] } | { unread: string };
  const before: Content = 'found' in saved ? { found: new Map(saved.found) } : saved;
  // A sample is the package's files, or the tarball itself.
  const nextFiles = attempt(() => {
    const files = readDirectory(work);
    const tarballs = files.filter(([f]) => /\.(?:tgz|tar\.gz)$/.test(f));
    return tarballs.length === 1 ? readTarball(tarballs[0]![1]) : files;
  });
  // Reading nothing would look like adding nothing.
  if (typeof nextFiles !== 'string' && !nextFiles.length) return { id, error: 'no files read' };
  const sample = samples.find((x) => x.id === id)!;
  const after: Content =
    typeof nextFiles === 'string' ? { unread: nextFiles } : { found: kindsIn(nextFiles) };
  const versions = { next: { version: sample.to }, reference: { version: sample.from } };
  const signals = contentSignals(versions, after, hasKinds(after) ? before : undefined);
  const next = typeof nextFiles === 'string' ? undefined : manifest(nextFiles);
  const scripts =
    next === undefined
      ? []
      : installScripts(sample, JSON.parse(readFileSync(`${prev}.json`, 'utf8')), next);
  return {
    id,
    signals: [...scripts, ...signals].map((x) => x.id),
    ...(next === undefined ? { scriptsUnknown: true as const } : {}),
    files: typeof nextFiles === 'string' ? 'not read' : String(nextFiles.length),
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
    return r?.signals ? [{ s, signals: r.signals, scriptsUnknown: !!r.scriptsUnknown }] : [];
  });
  type Measured = (typeof measured)[number];
  const has = (m: Measured, id: SignalId) => m.signals.includes(id);
  const notMeasured = samples.filter((s) => !byId.get(s.id)?.signals);
  const withoutScripts = measured.filter((m) => !m.scriptsUnknown && !has(m, 'install-scripts'));
  // With an origin or timing signal, a content signal makes a BLOCK.
  const content = (m: Measured) => m.signals.some((id) => SIGNALS[id] === 'content');
  const month = (s: Sample) => s.zip.split('/').at(-1)!.slice(0, 7);
  const count = (set: Measured[], id: SignalId) => set.filter((m) => has(m, id)).length;
  // The signals this evaluation computes: the content group and the unchecked one.
  const computed = (Object.keys(SIGNALS) as SignalId[]).filter(
    (id) => SIGNALS[id] === 'content' || SIGNALS[id] === 'unchecked',
  );

  console.log(`## Malicious releases: ${measured.length} measured of ${samples.length}\n`);
  console.log(
    `With a content signal: ${measured.filter(content).length}. ` +
      `Without an install-script change: ${withoutScripts.length}, ` +
      `of which ${withoutScripts.filter(content).length} have another content signal. ` +
      `Install scripts not known (no package.json, or not valid JSON): ${measured.filter((m) => m.scriptsUnknown).length}.\n`,
  );
  console.log('| Signal | Samples | Without an install-script change |');
  console.log('| --- | --- | --- |');
  for (const id of computed) {
    const rest = id === 'install-scripts' ? '' : String(count(withoutScripts, id));
    console.log(`| \`${id}\` | ${count(measured, id)} | ${rest} |`);
  }

  const missed = measured.filter((m) => !content(m));
  console.log(`\n### No content signal (${missed.length})\n`);
  console.log('| Month | Samples | Packages |');
  console.log('| --- | --- | --- |');
  for (const m of [...new Set(missed.map((x) => month(x.s)))].sort()) {
    const set = missed.filter((x) => month(x.s) === m);
    console.log(`| ${m} | ${set.length} | ${set.map((x) => `${x.s.name}@${x.s.to}`).join(', ')} |`);
  }

  console.log('\n### Incidents from test/incidents.test.ts\n');
  console.log('| Release | Signals | Files read in the sample |');
  console.log('| --- | --- | --- |');
  for (const s of samples.filter((x) => x.incident)) {
    const r = byId.get(s.id);
    const signals = r?.signals
      ? r.signals.map((id) => `\`${id}\``).join(', ') || 'none'
      : `**${r?.error ?? 'not scanned'}**`;
    console.log(`| ${s.name} ${s.from} -> ${s.to} | ${signals} | ${r?.files ?? ''} |`);
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
