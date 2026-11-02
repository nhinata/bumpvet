import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIGNALS } from '../src/types/signals.js';

// What these tests cover: CONTRIBUTING.md, Tests.

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

/** The text under a `## ` heading, up to the next one. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  expect(start, `the "## ${heading}" heading`).toBeGreaterThan(-1);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

/**
 * Each row of a verdict table as the groups it names in bold, sorted and
 * without repeats, and its verdict.
 */
function verdictRows(text: string) {
  return [...text.matchAll(/^\| (.+?) +\| (BLOCK|REVIEW|OK) +\|/gm)].map((m) => [
    [...new Set([...m[1]!.matchAll(/\*\*(\w+)\*\*/g)].map((g) => g[1]))].sort(),
    m[2],
  ]);
}

describe('documents', () => {
  // Users read the groups in DESIGN.md's table of signals; SIGNALS is what decides.
  it('DESIGN.md lists the signals of SIGNALS, in its order and with its groups', () => {
    const rows = [
      ...section(read('DESIGN.md'), 'Signals').matchAll(/^\| `([^`]+)` +\| (\w+) +\|/gm),
    ].map((m) => [m[1], m[2]]);
    expect(rows).toEqual(Object.entries(SIGNALS));
  });

  // README.md shows DESIGN.md's verdict table (whose rows `decide` is tested
  // against) in words for its readers; both name each group in bold.
  it('README.md has the verdict table of DESIGN.md', () => {
    const design = verdictRows(section(read('DESIGN.md'), 'Verdict table'));
    const readme = verdictRows(section(read('README.md'), 'How it decides'));
    expect(design.length, "rows of DESIGN.md's verdict table").toBeGreaterThan(0);
    expect(readme).toEqual(design);
  });
});
