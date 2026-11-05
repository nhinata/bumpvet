import { describe, expect, it } from 'vitest';
import { vetChanges, vetLockfiles } from '../src/vet.js';
import type { FetchTarball } from '../src/types/tarball.js';
import { fakeRegistry, lockfile, packument, tarballsAsPublished } from './helpers.js';

describe('vetChanges', () => {
  it('starts no more fetches after one fails', async () => {
    const changes = Array.from({ length: 20 }, (_, i) => ({
      name: `p${i}`,
      from: null,
      to: '1.0.0',
    }));
    let calls = 0;
    // Only the first fetch fails; without the stop, the other workers would go on through all 20.
    const firstFails = () =>
      ++calls === 1 ? Promise.reject(new Error('registry returned 503')) : Promise.resolve(null);
    await expect(
      vetChanges(changes, firstFails, tarballsAsPublished, { now: new Date() }, 8),
    ).rejects.toThrow(/503/);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let any leftover work run
    // The 8 workers each start one fetch before the failure is seen; none starts another.
    expect(calls).toBe(8);
  });

  it('stops the fetches under way when one fails', async () => {
    const changes = Array.from({ length: 8 }, (_, i) => ({
      name: `p${i}`,
      from: null,
      to: '1.0.0',
    }));
    const signals: AbortSignal[] = [];
    // The first fails; the others would wait for a retry until their signal stops them.
    const fetchPackument = (name: string, signal?: AbortSignal) => {
      signals.push(signal!);
      if (name === 'p0') return Promise.reject(new Error('registry returned 503'));
      return new Promise<null>((_, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    };
    await expect(
      vetChanges(changes, fetchPackument, tarballsAsPublished, { now: new Date() }, 8),
    ).rejects.toThrow(/503/);
    expect(signals).toHaveLength(8);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});

// The tarballs of the new version and the one it is compared with are read;
// not when the lockfile already installs something else (DESIGN.md, Decisions).
describe('vetChanges: which tarballs are read', () => {
  const registry = fakeRegistry(
    packument('pkg', [
      { version: '1.0.0', time: '2025-01-01T00:00:00Z', publisher: 'alice' },
      { version: '1.1.0', time: '2025-02-01T00:00:00Z', publisher: 'alice', bindingGyp: true },
    ]),
  );
  const now = new Date('2026-01-01T00:00:00Z');
  const reading = (fetch: FetchTarball = tarballsAsPublished) => {
    const read: string[] = [];
    const fetchTarball: FetchTarball = (manifest, what, signal) => {
      read.push(what);
      return fetch(manifest, what, signal);
    };
    return { read, fetchTarball };
  };
  const update = { name: 'pkg', from: '1.0.0', to: '1.1.0', integrity: 'sha512-pkg-1.1.0' };

  it('reads the new version and the one it is compared with, and reports what changed', async () => {
    const { read, fetchTarball } = reading();
    const [r] = await vetChanges([update], registry, fetchTarball, { now });
    expect(read).toEqual(['pkg@1.1.0', 'pkg@1.0.0']);
    expect(r?.signals.map((s) => [s.id, s.before, s.after])).toEqual([
      ['install-scripts', 'binding.gyp: none', 'binding.gyp: present'],
    ]);
  });

  it('reads only the new version of a package with nothing before it', async () => {
    const { read, fetchTarball } = reading();
    const change = { name: 'pkg', from: null, to: '1.0.0', integrity: 'sha512-pkg-1.0.0' };
    await vetChanges([change], registry, fetchTarball, { now });
    expect(read).toEqual(['pkg@1.0.0']);
  });

  it('does not read a tarball the lockfile does not install', async () => {
    const { read, fetchTarball } = reading();
    const changes = [
      { name: 'pkg', from: null, to: '1.0.0', integrity: 'sha512-other' },
      { name: 'pkg', from: null, to: '9.9.9' },
      { name: 'pkg', from: null, to: '1.0.0', source: 'git+https://example.com/x.git' },
    ];
    const results = await vetChanges(changes, registry, fetchTarball, { now });
    expect(results.map((r) => r.signals.map((s) => s.id))).toEqual([
      ['integrity-mismatch'],
      ['not-in-registry'],
      ['not-from-registry'],
    ]);
    expect(read).toEqual([]);
  });

  it('does not read the compared version when the new one was not read', async () => {
    const { read, fetchTarball } = reading(() =>
      Promise.resolve({ notChecked: 'over 256 MB to download' }),
    );
    const [r] = await vetChanges([update], registry, fetchTarball, { now });
    expect(read).toEqual(['pkg@1.1.0']);
    expect(r?.signals.map((s) => s.id)).toEqual(['tarball-not-read']);
  });
});

// Which old entry each change is compared with: the same version for tamper
// signals, the entry at the same path for what changed (`from`).
describe('vetLockfiles: what a change is compared with', () => {
  const now = new Date('2026-01-10T00:00:00Z');
  const at = (month: number) => `2025-${String(month).padStart(2, '0')}-01T00:00:00Z`;
  const registry = fakeRegistry(
    packument('semver', [
      { version: '6.3.1', time: at(1), publisher: 'alice' },
      { version: '7.6.0', time: at(2), publisher: 'alice', scripts: { postinstall: 'x' } },
    ]),
    packument('x', [
      { version: '1.0.0', time: at(1), publisher: 'alice' },
      { version: '2.0.0', time: at(2), publisher: 'alice' },
    ]),
    packument('y', [{ version: '1.2.0', time: at(1), publisher: 'alice' }]),
    packument('parent', [
      { version: '1.0.0', time: at(1), publisher: 'alice' },
      { version: '2.0.0', time: at(2), publisher: 'alice' },
    ]),
  );
  const vet = async (before: string, after: string) =>
    (await vetLockfiles(before, after, registry, tarballsAsPublished, { now })).map((r) => ({
      name: r.name,
      from: r.from,
      to: r.to,
      signals: r.signals.map((s) => s.id),
    }));
  const unpinned = { integrity: undefined, resolved: undefined };

  it('compares an upgrade with the entry at its path, not a bundled copy of the new version', async () => {
    const bundled = { version: '7.6.0', ...unpinned };
    const before = lockfile({
      'node_modules/semver': { version: '6.3.1' },
      'node_modules/npm/node_modules/semver': bundled,
    });
    const after = lockfile({
      'node_modules/semver': { version: '7.6.0' },
      'node_modules/npm/node_modules/semver': bundled,
    });
    expect(await vet(before, after)).toEqual([
      { name: 'semver', from: '6.3.1', to: '7.6.0', signals: ['install-scripts'] },
    ]);
  });

  it('flags a version that came from the registry elsewhere and now comes from another server', async () => {
    const before = lockfile({
      'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/x.git#aaa' },
      'node_modules/a/node_modules/x': { version: '2.0.0' },
    });
    const after = lockfile({
      'node_modules/x': { version: '2.0.0', resolved: 'https://evil.example/x.tgz' },
      'node_modules/a/node_modules/x': { version: '2.0.0' },
    });
    expect((await vet(before, after))[0]?.signals).toEqual(['source-changed']);
  });

  it('compares the integrity of a version with the old copy of that version', async () => {
    const before = lockfile({
      'node_modules/x': { version: '1.0.0' },
      'node_modules/a/node_modules/x': { version: '2.0.0', integrity: 'sha512-old' },
    });
    const after = lockfile({
      'node_modules/x': { version: '2.0.0' },
      'node_modules/a/node_modules/x': { version: '2.0.0', integrity: 'sha512-old' },
    });
    expect((await vet(before, after))[0]?.signals).toEqual(['integrity-mismatch']);
  });

  it('passes a dependency npm starts to bundle, which loses its integrity', async () => {
    const before = lockfile({
      'node_modules/parent': { version: '1.0.0' },
      'node_modules/parent/node_modules/y': { version: '1.2.0' },
    });
    const after = lockfile({
      'node_modules/parent': { version: '2.0.0' },
      'node_modules/parent/node_modules/y': { version: '1.2.0', ...unpinned },
    });
    expect(await vet(before, after)).toEqual([
      { name: 'parent', from: '1.0.0', to: '2.0.0', signals: [] },
      { name: 'y', from: '1.2.0', to: '1.2.0', signals: [] },
    ]);
  });

  it('keeps the comparison with each earlier version of a new version at several paths', async () => {
    const pkgs = fakeRegistry(
      packument('a', [
        { version: '0.9.0', time: at(1), publisher: 'alice', provenance: true },
        { version: '1.0.0', time: at(2), publisher: 'alice', scripts: { postinstall: 'x' } },
        { version: '2.0.0', time: at(3), publisher: 'alice', scripts: { postinstall: 'x' } },
      ]),
    );
    const before = lockfile({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b/node_modules/a': { version: '0.9.0' },
    });
    const after = lockfile({
      'node_modules/a': { version: '2.0.0' },
      'node_modules/b/node_modules/a': { version: '2.0.0' },
    });
    const results = await vetLockfiles(before, after, pkgs, tarballsAsPublished, { now });
    expect(results.map((r) => [r.from, r.verdict])).toEqual([
      ['1.0.0', 'ok'],
      ['0.9.0', 'block'],
    ]);
  });

  // npm fetches it from the registry by name and version (DESIGN.md, threat model);
  // the configured registry is issue #17.
  it('passes an entry that lost both `resolved` and its integrity', async () => {
    const before = lockfile({ 'node_modules/y': { version: '1.2.0' } });
    const after = lockfile({ 'node_modules/y': { version: '1.2.0', ...unpinned } });
    expect(await vet(before, after)).toEqual([
      { name: 'y', from: '1.2.0', to: '1.2.0', signals: [] },
    ]);
  });
});
