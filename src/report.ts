import { VERDICTS, type PackageResult, type Verdict } from './types/verdicts.js';

/**
 * How each line of a text report that lists packages starts, taking lines as
 * split at `\n`. Each start differs from every other at some fixed column: a
 * verdict line has its label at column 0, a package listed with the one above
 * has `+` at column 6, a signal line has spaces up to column 10 and then a
 * signal id (one of SIGNALS), and a path line has spaces up to column 12 and
 * then `in `. Text from the lockfile or the registry (names, versions, paths,
 * signal values) comes only after the start of its own line, and printable
 * keeps it from starting a new one, so a package cannot make a line look like
 * a line of another kind.
 */
export const LINE_START = {
  block: 'BLOCK   ',
  review: 'REVIEW  ',
  ok: 'OK      ',
  sameAsAbove: '      + ',
  signal: ' '.repeat(10),
  path: `${' '.repeat(12)}in `,
} as const;

/** A lockfile entry without a version has '' (see LockPackage). */
const shown = (version: string | null) => (version === '' ? '(no version)' : version);

const ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * `text` with every character escaped but letters, marks, numbers,
 * punctuation, symbols and spaces (Unicode categories L, M, N, P, S and Zs),
 * so that text from the lockfile or the registry (install scripts, which
 * anyone can publish) cannot start a line of its own (see LINE_START), move
 * the cursor over the report, or reorder how a line looks (bidi controls such
 * as U+202E). Among them are the line and paragraph separators U+2028 and
 * U+2029: Unicode line breaking (UAX #14) breaks lines there, although
 * LINE_START splits lines only at `\n`. Characters unassigned in the Unicode
 * of the running Node are escaped too, as a newer Unicode may make them
 * format characters. Backslashes are escaped as well, so that a newline and
 * the two characters `\n` do not look the same.
 */
export const printable = (text: string): string =>
  text.replace(/\\|[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/gu, (c) => {
    const hex = c.codePointAt(0)!.toString(16);
    return ESCAPES[c] ?? (hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`);
  });

/**
 * The fields in which results listed together may differ: the text report
 * shows them for each package.
 */
const PER_PACKAGE = { name: undefined, paths: undefined } satisfies Partial<
  Record<keyof PackageResult, undefined>
>;

/**
 * What two results that differ only in PER_PACKAGE have in common: the text
 * report lists such results one after another under one set of signals (many
 * packages of one release, such as platform packages, otherwise repeat the
 * same lines). Every other field is in the key, including any added later, as
 * long as it is JSON data like the rest of the result, so that results that
 * differ in anything else are never listed together.
 */
const shared = (r: PackageResult) => JSON.stringify({ ...r, ...PER_PACKAGE });

/**
 * The text report. Each REVIEW and BLOCK package is followed by the lockfile
 * paths it was found at, one per line.
 */
export function formatText(results: PackageResult[]): string {
  if (results.length === 0) return 'No dependency versions changed.\n';
  const lines: string[] = [];
  for (const verdict of VERDICTS) {
    const group = results.filter((r) => r.verdict === verdict);
    if (verdict === 'ok') {
      if (group.length)
        lines.push(
          `${LINE_START.ok}${group.length} package${group.length === 1 ? '' : 's'} with no signals`,
        );
      continue;
    }
    const keys = group.map(shared);
    group.forEach((r, i) => {
      const sameAsNext = keys[i] === keys[i + 1];
      const start = keys[i] === keys[i - 1] ? LINE_START.sameAsAbove : LINE_START[verdict];
      lines.push(printable(`${start}${r.name} ${shown(r.from) ?? '(new)'} -> ${shown(r.to)}`));
      for (const path of r.paths ?? []) lines.push(printable(`${LINE_START.path}${path}`));
      if (sameAsNext) return;
      const width = Math.max(...r.signals.map((s) => s.id.length));
      for (const s of r.signals)
        lines.push(
          printable(`${LINE_START.signal}${s.id.padEnd(width)}  ${s.before} -> ${s.after}`),
        );
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
