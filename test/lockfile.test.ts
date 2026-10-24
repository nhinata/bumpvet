import { describe, expect, it } from 'vitest';
import { diffLockfiles, parseLockfile } from '../src/lockfile.js';
import { lockfile } from './helpers.js';

const raw = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages });

describe('parseLockfile', () => {
  it('skips workspace links and workspace folders', () => {
    const text = raw({
      '': { name: 'app' },
      'packages/lib': { name: 'lib', version: '1.0.0' },
      'node_modules/lib': { resolved: 'packages/lib', link: true },
    });
    expect(parseLockfile(text).size).toBe(0);
  });

  it('reads scoped names from the path', () => {
    const text = lockfile({ 'node_modules/@ctrl/tinycolor': { version: '4.1.1' } });
    expect(parseLockfile(text).get('node_modules/@ctrl/tinycolor')?.name).toBe('@ctrl/tinycolor');
  });

  it('reads the name from `name` when there is one, as npm aliases have', () => {
    const text = lockfile({ 'node_modules/my-alias': { version: '5.3.0', name: 'chalk' } });
    expect(parseLockfile(text).get('node_modules/my-alias')?.name).toBe('chalk');
  });

  it('uses the path when `name` is empty', () => {
    const text = lockfile({ 'node_modules/a': { version: '1.0.0', name: '' } });
    expect(parseLockfile(text).get('node_modules/a')?.name).toBe('a');
  });

  describe('where a package comes from', () => {
    const from = (entry: Record<string, unknown>) =>
      parseLockfile(raw({ 'node_modules/a': { version: '1.0.0', ...entry } })).get('node_modules/a')
        ?.elsewhere;

    it('is the registry without `resolved` when there is an integrity (omit-lockfile-registry-resolved)', () => {
      expect(from({ integrity: 'sha512-x' })).toBeUndefined();
    });

    it.each([
      ['neither `resolved` nor an integrity', {}],
      ['an empty `resolved`', { resolved: '' }],
    ])('is unknown with %s', (_, entry) => {
      expect(from(entry)).toBe('unknown source');
    });

    it('is the URL for git and other non-registry sources', () => {
      expect(from({ resolved: 'git+ssh://git@github.com/x/y.git#abc' })).toBe(
        'git+ssh://git@github.com/x/y.git#abc',
      );
    });

    it.each(['x/y/../lodash', '%2e%2e', 'foo#bar', 'foo?x=1', 'foo\\bar', '.hidden', '@scope/a/b'])(
      'is not trusted for the name %j, which would not look itself up in the registry',
      (name) => {
        expect(from({ name, integrity: 'sha512-x' })).toBe(
          `invalid package name ${JSON.stringify(name)}`,
        );
      },
    );

    it.each(['lodash', '@ctrl/tinycolor', 'JSONStream', 'a.b_c-d~e'])(
      'accepts the name %j',
      (name) => {
        expect(from({ name, integrity: 'sha512-x' })).toBeUndefined();
      },
    );
  });

  it('skips entries and fields of the wrong type', () => {
    const text = raw({
      'node_modules/null-entry': null,
      'node_modules/number-version': { version: 1, integrity: 'sha512-x' },
      'node_modules/ok': { version: '1.0.0', name: 7, resolved: 5, integrity: 'sha512-x' },
    });
    expect([...parseLockfile(text)]).toEqual([
      [
        'node_modules/ok',
        {
          name: 'ok',
          version: '1.0.0',
          integrity: 'sha512-x',
          resolved: undefined,
          elsewhere: undefined,
        },
      ],
    ]);
  });

  it('names the file when it is not JSON', () => {
    expect(() => parseLockfile('{', 'the old lockfile')).toThrow(
      'the old lockfile is not valid JSON',
    );
  });

  it.each([1, 4])('rejects lockfileVersion %i', (lockfileVersion) => {
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion, packages: {} }))).toThrow(
      /lockfileVersion 2 or 3/,
    );
  });
});

describe('diffLockfiles', () => {
  it('reports upgraded and added packages, not unchanged ones', () => {
    const before = lockfile({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '2.0.0' },
    });
    const after = lockfile({
      'node_modules/a': { version: '1.1.0' },
      'node_modules/b': { version: '2.0.0' },
      'node_modules/c': { version: '3.0.0' },
    });
    expect(diffLockfiles(before, after)).toEqual([
      {
        name: 'a',
        from: '1.0.0',
        to: '1.1.0',
        integrity: 'sha512-a-1.1.0',
        resolved: 'https://registry.npmjs.org/a/-/x-1.1.0.tgz',
      },
      {
        name: 'c',
        from: null,
        to: '3.0.0',
        integrity: 'sha512-c-3.0.0',
        resolved: 'https://registry.npmjs.org/c/-/x-3.0.0.tgz',
      },
    ]);
  });

  it('ignores a version that only moved to another path', () => {
    const before = lockfile({ 'node_modules/x/node_modules/a': { version: '1.0.0' } });
    const after = lockfile({ 'node_modules/a': { version: '1.0.0' } });
    expect(diffLockfiles(before, after)).toEqual([]);
  });

  it('compares a package that moved path with the version installed elsewhere', () => {
    const before = lockfile({ 'node_modules/x/node_modules/a': { version: '1.0.0' } });
    const after = lockfile({ 'node_modules/a': { version: '1.1.0' } });
    expect(diffLockfiles(before, after)[0]).toMatchObject({
      name: 'a',
      from: '1.0.0',
      to: '1.1.0',
    });
  });

  it('lists a new version once, whatever paths and earlier versions it has', () => {
    const before = lockfile({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b/node_modules/a': { version: '0.9.0' },
    });
    const after = lockfile({
      'node_modules/a': { version: '2.0.0' },
      'node_modules/b/node_modules/a': { version: '2.0.0' },
      'node_modules/c/node_modules/a': { version: '2.0.0' },
    });
    expect(diffLockfiles(before, after)).toHaveLength(1);
  });

  it('lists a new version once when its paths record different URLs for the same integrity', () => {
    const after = lockfile({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b/node_modules/a': { version: '1.0.0', resolved: undefined },
    });
    expect(diffLockfiles(null, after)).toHaveLength(1);
  });

  it('names the file that is not JSON', () => {
    expect(() => diffLockfiles('{', lockfile({}))).toThrow('the old lockfile is not valid JSON');
    expect(() => diffLockfiles(null, 'not json')).toThrow('the new lockfile is not valid JSON');
  });

  // The same version is a change when what npm installs for it may differ (DESIGN.md:
  // integrity-mismatch, source-changed, tarball-mismatch). A missing field matches nothing.
  describe('the same version counts as changed', () => {
    const one = (entry: Record<string, unknown>) =>
      lockfile({ 'node_modules/ms': { version: '2.1.3', ...entry } });

    it('when its integrity changed', () => {
      expect(
        diffLockfiles(one({ integrity: 'sha512-good' }), one({ integrity: 'sha512-evil' })),
      ).toEqual([
        {
          name: 'ms',
          from: '2.1.3',
          to: '2.1.3',
          integrity: 'sha512-evil',
          resolved: 'https://registry.npmjs.org/ms/-/x-2.1.3.tgz',
          fromIntegrity: 'sha512-good',
        },
      ]);
    });

    it('when it moved off the registry', () => {
      const evil = 'https://evil.example/ms.tgz';
      expect(diffLockfiles(one({}), one({ resolved: evil }))).toMatchObject([
        { name: 'ms', from: '2.1.3', to: '2.1.3', source: evil },
      ]);
    });

    it('when `resolved` changed and there is no integrity', () => {
      const other = 'https://registry.npmjs.org/ms/-/ms-0.7.1.tgz';
      expect(
        diffLockfiles(
          one({ integrity: undefined }),
          one({ integrity: undefined, resolved: other }),
        ),
      ).toMatchObject([{ name: 'ms', from: '2.1.3', to: '2.1.3', resolved: other }]);
    });

    it('when it dropped its integrity, even if the old entry had no `resolved`', () => {
      const before = one({ resolved: undefined });
      const after = one({
        integrity: undefined,
        resolved: 'https://registry.npmjs.org/evil/-/e.tgz',
      });
      expect(diffLockfiles(before, after)).toHaveLength(1);
    });

    it('when a git dependency moved to another commit', () => {
      const at = (sha: string) =>
        one({ resolved: `git+ssh://git@github.com/x/ms.git#${sha}`, integrity: undefined });
      expect(diffLockfiles(at('abc'), at('def'))).toHaveLength(1);
    });
  });

  describe('the same version counts as unchanged', () => {
    const one = (entry: Record<string, unknown>) =>
      lockfile({ 'node_modules/ms': { version: '2.1.3', ...entry } });

    it('when only `resolved` changed and the integrity is the same: npm checks the content', () => {
      const after = one({ resolved: 'https://registry.npmjs.org/ms/-/other.tgz' });
      expect(diffLockfiles(one({}), after)).toEqual([]);
      expect(diffLockfiles(one({}), one({ resolved: undefined }))).toEqual([]);
    });

    it.each([
      ['a git dependency', { resolved: 'git+ssh://git@github.com/x/ms.git#abc' }],
      ['a file: dependency', { resolved: 'file:../ms' }],
      ['an entry with neither `resolved` nor an integrity', { resolved: undefined }],
    ])('for %s that did not change', (_, entry) => {
      const text = one({ ...entry, integrity: undefined });
      expect(diffLockfiles(text, text)).toEqual([]);
    });
  });
});
