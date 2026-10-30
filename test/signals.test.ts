import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeSignals } from '../src/signals.js';
import { decide } from '../src/verdict.js';
import { SIGNALS, type Signal } from '../src/types.js';
import { packument } from './helpers.js';

const now = new Date('2026-01-10T00:00:00Z');
const ids = (signals: Signal[]) => signals.map((s) => s.id);

const history = [
  { version: '1.0.0', time: '2025-01-01T00:00:00Z', publisher: 'alice', provenance: true },
  { version: '1.1.0', time: '2025-06-01T00:00:00Z', publisher: 'bob', provenance: true },
];

describe('computeSignals', () => {
  it('finds nothing in an ordinary release', () => {
    const p = packument('pkg', [
      ...history,
      { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'alice', provenance: true },
    ]);
    expect(computeSignals({ name: 'pkg', from: '1.1.0', to: '1.2.0' }, p, { now })).toEqual([]);
  });

  it('flags a publisher who did not publish any of the recent versions', () => {
    const p = packument('pkg', [
      ...history,
      { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'mallory' },
    ]);
    const signals = computeSignals({ name: 'pkg', from: '1.1.0', to: '1.2.0' }, p, { now });
    expect(ids(signals)).toEqual(['publisher-changed', 'provenance-lost']);
    expect(signals[0]).toEqual({
      id: 'publisher-changed',
      group: 'origin',
      before: 'alice, bob',
      after: 'mallory',
    });
  });

  it('does not flag a new publisher when the release has provenance', () => {
    const p = packument('pkg', [
      ...history,
      {
        version: '1.2.0',
        time: '2025-12-01T00:00:00Z',
        publisher: 'GitHub Actions',
        provenance: true,
      },
    ]);
    expect(computeSignals({ name: 'pkg', from: '1.1.0', to: '1.2.0' }, p, { now })).toEqual([]);
  });

  it('flags provenance that the previous version had and the new one lacks', () => {
    const p = packument('pkg', [
      ...history,
      { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'alice' },
    ]);
    expect(ids(computeSignals({ name: 'pkg', from: '1.1.0', to: '1.2.0' }, p, { now }))).toEqual([
      'provenance-lost',
    ]);
  });

  it('does not flag a package that never had provenance', () => {
    const p = packument('pkg', [
      { version: '1.0.0', time: '2025-01-01T00:00:00Z', publisher: 'alice' },
      { version: '1.1.0', time: '2025-12-01T00:00:00Z', publisher: 'alice' },
    ]);
    expect(computeSignals({ name: 'pkg', from: '1.0.0', to: '1.1.0' }, p, { now })).toEqual([]);
  });

  it('flags a version published within the fresh window', () => {
    const p = packument('pkg', [
      ...history,
      { version: '1.2.0', time: '2026-01-09T22:00:00Z', publisher: 'alice', provenance: true },
    ]);
    const [s] = computeSignals({ name: 'pkg', from: '1.1.0', to: '1.2.0' }, p, { now });
    expect(s).toMatchObject({ id: 'fresh-publish', after: '2h old' });
  });

  it('flags added or changed install scripts against the version being replaced', () => {
    const p = packument('pkg', [
      ...history,
      {
        version: '1.2.0',
        time: '2025-12-01T00:00:00Z',
        publisher: 'alice',
        provenance: true,
        scripts: { postinstall: 'node x.js', test: 'vitest' },
      },
    ]);
    const [s] = computeSignals({ name: 'pkg', from: '1.1.0', to: '1.2.0' }, p, { now });
    expect(s).toEqual({
      id: 'install-scripts',
      group: 'content',
      before: 'postinstall: none',
      after: 'postinstall: node x.js',
    });
  });

  it('does not flag a removed install script', () => {
    const p = packument('pkg', [
      {
        version: '1.0.0',
        time: '2025-01-01T00:00:00Z',
        publisher: 'alice',
        scripts: { install: 'node check.js' },
      },
      { version: '1.1.0', time: '2025-12-01T00:00:00Z', publisher: 'alice' },
    ]);
    expect(computeSignals({ name: 'pkg', from: '1.0.0', to: '1.1.0' }, p, { now })).toEqual([]);
  });

  it('compares a newly added package with the version published before it', () => {
    const p = packument('pkg', [
      ...history,
      { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'alice' },
    ]);
    expect(ids(computeSignals({ name: 'pkg', from: null, to: '1.2.0' }, p, { now }))).toEqual([
      'provenance-lost',
    ]);
  });

  it('flags a lockfile integrity that differs from the registry', () => {
    const p = packument('pkg', [
      ...history,
      {
        version: '1.2.0',
        time: '2025-12-01T00:00:00Z',
        publisher: 'alice',
        provenance: true,
        integrity: 'sha512-real',
      },
    ]);
    const signals = computeSignals(
      { name: 'pkg', from: '1.1.0', to: '1.2.0', integrity: 'sha512-other' },
      p,
      { now },
    );
    expect(ids(signals)).toEqual(['integrity-mismatch']);
  });

  // npm checks only the strongest algorithm's hashes and accepts content that
  // matches any one of them (DESIGN.md, threat model). With `resolved` at another
  // server, each of these installs that server's tarball.
  describe('the registry hash listed beside another one', () => {
    const p = packument('pkg', [
      ...history,
      { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'alice', provenance: true },
    ]);
    const registry = 'sha512-pkg-1.2.0';
    const shasum = 'ab8ece0c4062da5f6d2fa1d07fc4cdb5f8b9b25b';
    p.versions['1.2.0']!.dist!.shasum = shasum;
    const vet = (integrity: string) =>
      ids(
        computeSignals(
          {
            name: 'pkg',
            from: '1.1.0',
            to: '1.2.0',
            integrity,
            resolved: 'https://evil.example/p.tgz',
          },
          p,
          { now },
        ),
      );

    it('flags a second sha512 hash', () => {
      expect(vet(`${registry} sha512-evil`)).toEqual(['integrity-mismatch']);
    });

    it('flags a sha512 hash after the registry sha1', () => {
      const sha1 = `sha1-${Buffer.from(shasum, 'hex').toString('base64')}`;
      expect(vet(`${sha1} sha512-evil`)).toEqual(['integrity-mismatch']);
    });

    it('checks `resolved` when the first hash uses an algorithm the registry does not give', () => {
      expect(vet('sha384-x sha512-evil')).toEqual(['tarball-mismatch']);
    });
  });

  // npm writes a single hash, so a second one counts against the registry even
  // where npm would not check it (DESIGN.md, decisions).
  it('flags a sha1 hash beside the registry sha512', () => {
    const p = packument('pkg', [
      ...history,
      { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'alice', provenance: true },
    ]);
    expect(
      ids(
        computeSignals(
          { name: 'pkg', from: '1.1.0', to: '1.2.0', integrity: 'sha512-pkg-1.2.0 sha1-x' },
          p,
          { now },
        ),
      ),
    ).toEqual(['integrity-mismatch']);
  });

  it('does not compare integrities that use different algorithms', () => {
    const p = packument('pkg', [
      ...history,
      {
        version: '1.2.0',
        time: '2025-12-01T00:00:00Z',
        publisher: 'alice',
        provenance: true,
        integrity: 'sha512-real',
      },
    ]);
    expect(
      computeSignals({ name: 'pkg', from: '1.1.0', to: '1.2.0', integrity: 'sha1-old' }, p, {
        now,
      }),
    ).toEqual([]);
  });

  it('flags a lockfile integrity that changed for the same version', () => {
    const p = packument('pkg', [
      ...history,
      {
        version: '1.2.0',
        time: '2025-12-01T00:00:00Z',
        publisher: 'alice',
        provenance: true,
        integrity: 'sha512-real',
      },
    ]);
    const signals = computeSignals(
      {
        name: 'pkg',
        from: '1.2.0',
        to: '1.2.0',
        integrity: 'sha512-other',
        fromIntegrity: 'sha512-real',
      },
      p,
      { now },
    );
    expect(signals).toEqual([
      { id: 'integrity-mismatch', group: 'tamper', before: 'sha512-real', after: 'sha512-other' },
    ]);
  });

  it('flags a package that moved off the registry as tampering', () => {
    const [s] = computeSignals(
      { name: 'pkg', from: '1.1.0', to: '1.1.0', source: 'https://evil.example/pkg.tgz' },
      null,
      { now },
    );
    expect(s).toEqual({
      id: 'source-changed',
      group: 'tamper',
      before: 'npm registry',
      after: 'https://evil.example/pkg.tgz',
    });
  });

  it('flags a package from outside the registry as an origin signal', () => {
    const git = 'git+ssh://git@github.com/x/y.git#abc';
    expect(
      computeSignals({ name: 'pkg', from: null, to: '1.0.0', source: git }, null, { now }),
    ).toEqual([{ id: 'not-from-registry', group: 'origin', before: 'not installed', after: git }]);
    expect(
      computeSignals(
        { name: 'pkg', from: '0.9.0', to: '1.0.0', source: git, fromSource: 'git+ssh://old' },
        null,
        { now },
      )[0],
    ).toMatchObject({
      id: 'not-from-registry',
      before: 'git+ssh://old',
    });
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'flags version %j, which only an inherited member would match, as not in the registry',
    (version) => {
      const p = packument('pkg', history);
      expect(ids(computeSignals({ name: 'pkg', from: '1.1.0', to: version }, p, { now }))).toEqual([
        'not-in-registry',
      ]);
    },
  );

  describe('tarball-mismatch', () => {
    const p = packument('lodash', [
      ...history,
      { version: '1.2.0', time: '2025-12-01T00:00:00Z', publisher: 'alice', provenance: true },
    ]);
    const canonical = 'https://registry.npmjs.org/lodash/-/x-1.2.0.tgz';
    const vet = (resolved: string, integrity?: string) =>
      ids(
        computeSignals({ name: 'lodash', from: '1.1.0', to: '1.2.0', resolved, integrity }, p, {
          now,
        }),
      );

    it.each([
      ['another version of the package', 'https://registry.npmjs.org/lodash/-/x-0.1.0.tgz'],
      ['another package', 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz'],
      ['another package through ..', 'https://registry.npmjs.org/lodash/-/../../evil/-/e.tgz'],
      ['another package through %2f', 'https://registry.npmjs.org/lodash/-/..%2f..%2fevil%2fe.tgz'],
      [
        'another package through backslashes',
        'https://registry.npmjs.org/lodash/-/..\\..\\evil.tgz',
      ],
    ])('flags %s when there is no integrity to pin the content', (_, resolved) => {
      expect(vet(resolved)).toEqual(['tarball-mismatch']);
    });

    it('flags it when the lockfile integrity cannot be compared (sha1 against sha512)', () => {
      expect(vet('https://registry.npmjs.org/evil/-/evil-1.0.0.tgz', 'sha1-abc')).toEqual([
        'tarball-mismatch',
      ]);
    });

    it('flags a URL the registry gives nothing to compare with', () => {
      const bare = packument('lodash', [{ version: '1.2.0', time: '2025-12-01T00:00:00Z' }]);
      delete bare.versions['1.2.0']!.dist!.tarball;
      const change = { name: 'lodash', from: null, to: '1.2.0', resolved: canonical };
      expect(computeSignals(change, bare, { now })[0]).toEqual({
        id: 'tarball-mismatch',
        group: 'tamper',
        before: 'no tarball URL in the registry',
        after: canonical,
      });
    });

    it('compares a sha1 integrity with the registry shasum', () => {
      const old = packument('lodash', [{ version: '1.2.0', time: '2025-12-01T00:00:00Z' }]);
      // async@0.1.0's shasum, and the same hash as a lockfile writes it
      old.versions['1.2.0']!.dist!.shasum = 'ab8ece0c4062da5f6d2fa1d07fc4cdb5f8b9b25b';
      const change = (integrity: string) => ({
        name: 'lodash',
        from: null,
        to: '1.2.0',
        integrity,
        resolved: 'https://registry.npmjs.org/elsewhere.tgz',
      });
      expect(
        ids(computeSignals(change('sha1-q47ODEBi2l9tL6HQf8TNtfi5sls='), old, { now })),
      ).toEqual([]);
      expect(ids(computeSignals(change('sha1-evil'), old, { now }))).toEqual([
        'integrity-mismatch',
      ]);
    });

    it('falls back to a sha1 `integrity` when the registry has no usable shasum', () => {
      const old = packument('lodash', [{ version: '1.2.0', time: '2025-12-01T00:00:00Z' }]);
      old.versions['1.2.0']!.dist!.integrity = 'sha1-good';
      const change = {
        name: 'lodash',
        from: null,
        to: '1.2.0',
        integrity: 'sha1-evil',
        resolved: 'https://registry.npmjs.org/lodash/-/x-1.2.0.tgz',
      };
      expect(ids(computeSignals(change, old, { now }))).toEqual(['integrity-mismatch']);
    });

    it("trusts the registry's own tarball URL without an integrity", () => {
      expect(vet(canonical)).toEqual([]);
    });

    it('leaves the URL alone when the integrity matches the registry: npm checks the content', () => {
      expect(
        vet('https://registry.npmjs.org/evil/-/evil-1.0.0.tgz', 'sha512-lodash-1.2.0'),
      ).toEqual([]);
    });
  });

  it('flags a version the registry does not serve', () => {
    const p = packument('pkg', [
      ...history,
      { version: '1.2.0', time: '2025-12-01T00:00:00Z', removed: true },
    ]);
    expect(ids(computeSignals({ name: 'pkg', from: '1.1.0', to: '1.2.0' }, p, { now }))).toEqual([
      'not-in-registry',
    ]);
    expect(ids(computeSignals({ name: 'nope', from: null, to: '1.0.0' }, null, { now }))).toEqual([
      'not-in-registry',
    ]);
  });
});

// The verdict table in DESIGN.md, row by row.
describe('decide', () => {
  // A real signal of each group, so the rows read like what bumpvet reports.
  const of: Record<Signal['group'], Signal> = {
    origin: { id: 'publisher-changed', group: 'origin', before: 'alice', after: 'mallory' },
    timing: { id: 'fresh-publish', group: 'timing', before: '>= 72h old', after: '1h old' },
    content: { id: 'install-scripts', group: 'content', before: 'none', after: 'node x.js' },
    tamper: { id: 'integrity-mismatch', group: 'tamper', before: 'sha512-a', after: 'sha512-b' },
    unchecked: {
      id: 'previous-not-checked',
      group: 'unchecked',
      before: '1.0.0: over 512 MB unpacked',
      after: 'not compared',
    },
  };
  it.each([
    [[], 'ok'],
    [['timing'], 'ok'],
    [['origin'], 'review'],
    [['origin', 'origin'], 'review'],
    [['origin', 'timing'], 'review'],
    [['content'], 'review'],
    [['content', 'timing'], 'block'],
    [['origin', 'content'], 'block'],
    [['tamper'], 'block'],
    // Files left unread are a reason to look, not evidence: never more than REVIEW.
    [['unchecked'], 'review'],
    [['unchecked', 'timing'], 'review'],
    [['unchecked', 'origin', 'timing'], 'review'],
  ] as const)('%j -> %s', (groups, verdict) => {
    expect(decide(groups.map((g) => of[g]))).toBe(verdict);
  });
});

// Users read the groups in DESIGN.md's table of signals; SIGNALS is what decides.
it('DESIGN.md lists the signals of SIGNALS, in its order and with its groups', () => {
  const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
  const start = design.indexOf('\n## Signals\n');
  expect(start, 'the "## Signals" heading of DESIGN.md').toBeGreaterThan(-1);
  const section = design.slice(start, design.indexOf('\n## ', start + 1));
  const rows = [...section.matchAll(/^\| `([^`]+)` +\| (\w+) +\|/gm)].map((m) => [m[1], m[2]]);
  expect(rows).toEqual(Object.entries(SIGNALS));
});
