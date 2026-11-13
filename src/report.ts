import { VERDICTS, type PackageResult, type Verdict } from './types/verdicts.js';

const LABEL: Record<Verdict, string> = { block: 'BLOCK ', review: 'REVIEW', ok: 'OK    ' };

/** A lockfile entry without a version has '' (see LockPackage). */
const shown = (version: string | null) => (version === '' ? '(no version)' : version);

const ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * `text` with control and format characters escaped, so that text from the
 * lockfile or the registry (install scripts, which anyone can publish) cannot
 * start a line of its own, move the cursor over the report, or reorder how a
 * line looks (bidi controls such as U+202E). Backslashes are escaped as well,
 * so that a newline and the two characters `\n` do not look the same.
 */
export const printable = (text: string): string =>
  text.replace(/[\\\p{Cc}\p{Cf}]/gu, (c) => {
    const hex = c.codePointAt(0)!.toString(16);
    return ESCAPES[c] ?? (hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`);
  });

const INDENT = ' '.repeat(8);

/**
 * What two results that differ only by package name have in common: the text
 * report lists such results one after another under one set of signals (many
 * packages of one release, such as platform packages, otherwise repeat the
 * same lines). Every other field is in the key, including any added later, as
 * long as it is JSON data like the rest of the result, so that results that
 * differ in anything are never listed together.
 */
const allButName = (r: PackageResult) => JSON.stringify({ ...r, name: undefined });

export function formatText(results: PackageResult[]): string {
  if (results.length === 0) return 'No dependency versions changed.\n';
  const lines: string[] = [];
  for (const verdict of VERDICTS) {
    const group = results.filter((r) => r.verdict === verdict);
    if (verdict === 'ok') {
      if (group.length)
        lines.push(
          `${LABEL.ok}  ${group.length} package${group.length === 1 ? '' : 's'} with no signals`,
        );
      continue;
    }
    const keys = group.map(allButName);
    group.forEach((r, i) => {
      const sameAsNext = keys[i] === keys[i + 1];
      const label = keys[i] === keys[i - 1] ? INDENT : `${LABEL[verdict]}  `;
      lines.push(printable(`${label}${r.name} ${shown(r.from) ?? '(new)'} -> ${shown(r.to)}`));
      if (sameAsNext) return;
      const width = Math.max(...r.signals.map((s) => s.id.length));
      for (const s of r.signals)
        lines.push(printable(`${INDENT}${s.id.padEnd(width)}  ${s.before} -> ${s.after}`));
    });
  }
  return lines.join('\n') + '\n';
}

export function formatJson(results: PackageResult[]): string {
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  return (
    JSON.stringify(
      {
        summary: Object.fromEntries(VERDICTS.map((v) => [v, count(v)])),
        packages: results,
      },
      null,
      2,
    ) + '\n'
  );
}
