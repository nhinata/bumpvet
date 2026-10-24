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
      { name: 'a', from: '1.0.0', to: '1.1.0', integrity: undefined },
      { name: 'c', from: null, to: '3.0.0', integrity: undefined },
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

  it('rejects lockfileVersion 1', () => {
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 1, dependencies: {} }))).toThrow(
      /lockfileVersion 2 or 3/,
    );
  });
});
