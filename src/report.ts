import type { PackageResult, Verdict } from './types.js';

const ORDER: Verdict[] = ['block', 'review', 'ok'];
const LABEL: Record<Verdict, string> = { block: 'BLOCK ', review: 'REVIEW', ok: 'OK    ' };

/** A lockfile entry without a version has '' (see LockPackage). */
const shown = (version: string | null) => (version === '' ? '(no version)' : version);

export function formatText(results: PackageResult[]): string {
  if (results.length === 0) return 'No dependency versions changed.\n';
  const lines: string[] = [];
  for (const verdict of ORDER) {
    const group = results.filter((r) => r.verdict === verdict);
    if (verdict === 'ok') {
      if (group.length)
        lines.push(
          `${LABEL.ok}  ${group.length} package${group.length === 1 ? '' : 's'} with no signals`,
        );
      continue;
    }
    for (const r of group) {
      lines.push(`${LABEL[verdict]}  ${r.name} ${shown(r.from) ?? '(new)'} -> ${shown(r.to)}`);
      const width = Math.max(...r.signals.map((s) => s.id.length));
      for (const s of r.signals)
        lines.push(`        ${s.id.padEnd(width)}  ${s.before} -> ${s.after}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function formatJson(results: PackageResult[]): string {
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  return (
    JSON.stringify(
      {
        summary: { block: count('block'), review: count('review'), ok: count('ok') },
        packages: results,
      },
      null,
      2,
    ) + '\n'
  );
}
