import { describe, expect, it } from 'vitest';
import { diffLockfiles, parseLockfile } from '../src/lockfile.js';
import { lockfile } from './helpers.js';

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
      { name: 'a', from: '1.0.0', to: '1.1.0', integrity: 'sha512-a-1.1.0' },
      { name: 'c', from: null, to: '3.0.0', integrity: 'sha512-c-3.0.0' },
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

  it('lists the same new version once even if it is installed at several paths', () => {
    const after = lockfile({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b/node_modules/a': { version: '1.0.0' },
    });
    expect(diffLockfiles(null, after)).toHaveLength(1);
  });

  it('reads scoped names from the path', () => {
    const after = lockfile({ 'node_modules/@ctrl/tinycolor': { version: '4.1.1' } });
    expect(diffLockfiles(null, after)[0]?.name).toBe('@ctrl/tinycolor');
  });

  it('keeps a package from outside the public registry, with its source', () => {
    const after = lockfile({
      'node_modules/from-git': {
        version: '1.0.0',
        resolved: 'git+ssh://git@github.com/x/y.git#abc',
        integrity: undefined,
      },
    });
    expect(diffLockfiles(null, after)).toEqual([
      {
        name: 'from-git',
        from: null,
        to: '1.0.0',
        integrity: undefined,
        source: 'git+ssh://git@github.com/x/y.git#abc',
      },
    ]);
  });

  it('reports the same version when its source changed', () => {
    const before = lockfile({ 'node_modules/foo': { version: '1.2.3', integrity: 'sha512-good' } });
    const after = lockfile({
      'node_modules/foo': {
        version: '1.2.3',
        integrity: 'sha512-evil',
        resolved: 'https://evil.example/foo.tgz',
      },
    });
    expect(diffLockfiles(before, after)).toEqual([
      {
        name: 'foo',
        from: '1.2.3',
        to: '1.2.3',
        integrity: 'sha512-evil',
        source: 'https://evil.example/foo.tgz',
        fromIntegrity: 'sha512-good',
      },
    ]);
  });

  it('reports the same version when only its integrity changed', () => {
    const before = lockfile({ 'node_modules/foo': { version: '1.2.3', integrity: 'sha512-good' } });
    const after = lockfile({ 'node_modules/foo': { version: '1.2.3', integrity: 'sha512-evil' } });
    expect(diffLockfiles(before, after)).toEqual([
      {
        name: 'foo',
        from: '1.2.3',
        to: '1.2.3',
        integrity: 'sha512-evil',
        fromIntegrity: 'sha512-good',
      },
    ]);
  });

  it('does not report a registry package that only lost its `resolved` field', () => {
    const before = lockfile({ 'node_modules/foo': { version: '1.2.3', integrity: 'sha512-good' } });
    const after = lockfile({
      'node_modules/foo': { version: '1.2.3', integrity: 'sha512-good', resolved: undefined },
    });
    expect(diffLockfiles(before, after)).toEqual([]);
  });

  it('lists one entry for a version installed at paths that had different versions before', () => {
    const before = lockfile({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b/node_modules/a': { version: '0.9.0' },
    });
    const after = lockfile({
      'node_modules/a': { version: '2.0.0' },
      'node_modules/b/node_modules/a': { version: '2.0.0' },
    });
    expect(diffLockfiles(before, after)).toHaveLength(1);
  });
});

describe('parseLockfile', () => {
  it('skips workspace links and workspace folders', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'packages/lib': { name: 'lib', version: '1.0.0' },
        'node_modules/lib': { resolved: 'packages/lib', link: true },
      },
    });
    expect(parseLockfile(text).size).toBe(0);
  });

  it('treats a package without `resolved` but with an integrity as from the registry', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/a': { version: '1.0.0', integrity: 'sha512-x' } },
    });
    expect(parseLockfile(text).get('node_modules/a')?.elsewhere).toBeUndefined();
  });

  it('marks a package with neither `resolved` nor an integrity as an unknown source', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/a': { version: '1.0.0' } },
    });
    expect(parseLockfile(text).get('node_modules/a')?.elsewhere).toBe('unknown source');
  });

  it.each([
    [
      'a name that claims another package than its URL',
      { name: 'lodash', resolved: 'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz' },
      'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz (not lodash)',
    ],
    [
      'a URL that reaches another package through ..',
      {
        name: 'lodash',
        resolved: 'https://registry.npmjs.org/lodash/-/../../evil/-/evil-1.0.0.tgz',
      },
      'https://registry.npmjs.org/lodash/-/../../evil/-/evil-1.0.0.tgz (not lodash)',
    ],
    [
      'a URL that reaches another package through %2e%2e',
      {
        name: 'lodash',
        resolved: 'https://registry.npmjs.org/lodash/-/%2e%2e/%2e%2e/evil/-/e.tgz',
      },
      'https://registry.npmjs.org/lodash/-/%2e%2e/%2e%2e/evil/-/e.tgz (not lodash)',
    ],
    [
      // URLs treat "\\" as "/", so this has no "/" as text but reaches evil
      'a URL that reaches another package through backslashes',
      { name: 'lodash', resolved: 'https://registry.npmjs.org/lodash/-/..\\..\\evil\\-\\e.tgz' },
      'https://registry.npmjs.org/lodash/-/..\\..\\evil\\-\\e.tgz (not lodash)',
    ],
    ['an empty `resolved`', { resolved: '', integrity: undefined }, 'unknown source'],
    ['a name with a path in it', { name: 'x/y/../lodash' }, 'invalid package name "x/y/../lodash"'],
  ])('does not trust %s', (_, fields, source) => {
    const text = lockfile({ 'node_modules/a': { version: '1.0.0', ...fields } });
    expect(parseLockfile(text).get('node_modules/a')?.elsewhere).toBe(source);
  });

  it('trusts a scoped package at its own registry URL', () => {
    const text = lockfile({
      'node_modules/@ctrl/tinycolor': {
        version: '4.1.0',
        resolved: 'https://registry.npmjs.org/@ctrl/tinycolor/-/tinycolor-4.1.0.tgz',
      },
    });
    expect(parseLockfile(text).get('node_modules/@ctrl/tinycolor')?.elsewhere).toBeUndefined();
  });

  it('trusts a registry package with no integrity at its own URL', () => {
    // npm sometimes writes registry entries without an integrity.
    const text = lockfile({ 'node_modules/a': { version: '1.0.0', integrity: undefined } });
    expect(parseLockfile(text).get('node_modules/a')?.elsewhere).toBeUndefined();
  });

  it('trusts an npm alias, which names the aliased package', () => {
    const text = lockfile({ 'node_modules/my-alias': { version: '5.3.0', name: 'chalk' } });
    expect(parseLockfile(text).get('node_modules/my-alias')).toMatchObject({
      name: 'chalk',
      elsewhere: undefined,
    });
  });

  it('uses the path when the name is empty', () => {
    const text = lockfile({ 'node_modules/a': { version: '1.0.0', name: '' } });
    expect(parseLockfile(text).get('node_modules/a')?.name).toBe('a');
  });

  it('names the file when it is not JSON', () => {
    expect(() => diffLockfiles('{', lockfile({}))).toThrow('the old lockfile is not valid JSON');
    expect(() => diffLockfiles(null, 'not json')).toThrow('the new lockfile is not valid JSON');
  });

  it('skips entries and fields of the wrong type', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/null-entry': null,
        'node_modules/number-version': { version: 1, integrity: 'sha512-x' },
        'node_modules/ok': { version: '1.0.0', name: 7, resolved: 5, integrity: 'sha512-x' },
      },
    });
    expect([...parseLockfile(text)]).toEqual([
      [
        'node_modules/ok',
        { name: 'ok', version: '1.0.0', integrity: 'sha512-x', elsewhere: undefined },
      ],
    ]);
  });

  it.each([1, 4])('rejects lockfileVersion %i', (lockfileVersion) => {
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion, packages: {} }))).toThrow(
      /lockfileVersion 2 or 3/,
    );
  });
});
