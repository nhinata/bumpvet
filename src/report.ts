import type { PackageResult, Verdict } from './types.js';

const ORDER: Verdict[] = ['block', 'review', 'ok'];
const LABEL: Record<Verdict, string> = { block: 'BLOCK ', review: 'REVIEW', ok: 'OK    ' };

/** A lockfile entry without a version has '' (see LockPackage). */
const shown = (version: string | null) => (version === '' ? '(no version)' : version);

const ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * `text` with control and format characters escaped, so that text from the
 * lockfile or the registry (install scripts, which anyone can publish) cannot
 * start a line of its own, move the cursor over the report, or reorder how a
 * line looks (bidi controls such as U+202E).
 */
export const printable = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}]/gu, (c) => {
    const hex = c.codePointAt(0)!.toString(16);
    return ESCAPES[c] ?? (hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`);
  });

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
      lines.push(
        printable(`${LABEL[verdict]}  ${r.name} ${shown(r.from) ?? '(new)'} -> ${shown(r.to)}`),
      );
      const width = Math.max(...r.signals.map((s) => s.id.length));
      for (const s of r.signals)
        lines.push(printable(`        ${s.id.padEnd(width)}  ${s.before} -> ${s.after}`));
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
