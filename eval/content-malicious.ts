/**
 * Content groundwork (issue #44), malicious side: which kinds of code real
 * malicious releases added, from samples of the Datadog dataset listed in
 * samples.json. Runs only in .github/workflows/eval-content.yml, in two steps:
 *
 *   fetch <dir>         on the runner: the encrypted sample ZIPs (checked
 *                       against their git blob hashes) and the tarballs they
 *                       are compared with (checked against the registry)
 *   scan <dir> <work>   in a container without network, after the workflow
 *                       has unzipped each sample to <work>/<id>
 *
 * Only the kinds of code are printed, never the code itself.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { added, fetchTarball, readDirectory, readTarball, scan } from './content.js';
import { load } from './updates.js';

interface Sample {
  id: string;
  name: string;
  from: string;
  to: string;
  missed: boolean;
  zip: string;
  blob: string;
}
const { dataset, samples } = JSON.parse(
  readFileSync(new URL('../../eval/samples.json', import.meta.url), 'utf8'),
) as { dataset: { repo: string; commit: string }; samples: Sample[] };

const [mode, dir, work] = process.argv.slice(2);
if (mode === 'fetch' && dir) {
  mkdirSync(join(dir, 'zips'), { recursive: true });
  mkdirSync(join(dir, 'prev'), { recursive: true });
  for (const s of samples) {
    const res = await fetch(
      `https://raw.githubusercontent.com/${dataset.repo}/${dataset.commit}/${s.zip}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!res.ok) throw new Error(`${s.zip}: ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    // The hash git gives the file at that commit, as the contents API lists it.
    const blob = createHash('sha1').update(`blob ${zip.length}\0`).update(zip).digest('hex');
    if (blob !== s.blob) throw new Error(`${s.zip}: hash does not match samples.json`);
    writeFileSync(join(dir, 'zips', `${s.id}.zip`), zip);
    const tgz = await fetchTarball((await load(s.name)).versions[s.from]?.dist);
    writeFileSync(join(dir, 'prev', `${s.id}.tgz`), tgz);
  }
} else if (mode === 'scan' && dir && work) {
  console.log('## Malicious releases\n');
  console.log('| Release | Missed today | Kinds added | Code files read |');
  console.log('| --- | --- | --- | --- |');
  for (const s of samples) {
    const prev = scan(readTarball(readFileSync(join(dir, 'prev', `${s.id}.tgz`))));
    // A sample is the package's files, or the tarball itself.
    let files = readDirectory(join(work, s.id));
    const tarballs = [...files.keys()].filter((f) => /\.(?:tgz|tar\.gz)$/.test(f));
    if (tarballs.length === 1) files = readTarball(files.get(tarballs[0]!)!);
    const next = scan(files);
    // Reading no code would look like adding nothing.
    const kinds = next.files
      ? added(prev, next)
          .map((k) => `\`${k}\``)
          .join(', ') || 'none'
      : '**no code read**';
    const read = `${prev.files} -> ${next.files}${next.tooLarge ? ` (${next.tooLarge} too large)` : ''}`;
    console.log(
      `| ${s.name} ${s.from} -> ${s.to} | ${s.missed ? 'yes' : 'no'} | ${kinds} | ${read} |`,
    );
  }
} else {
  console.error('usage: content-malicious fetch <dir> | scan <dir> <work>');
  process.exit(2);
}
