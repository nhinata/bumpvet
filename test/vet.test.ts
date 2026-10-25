import { describe, expect, it } from 'vitest';
import { vetChanges, vetLockfiles } from '../src/vet.js';
import { fakeRegistry, lockfile, packument } from './helpers.js';

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
    await expect(vetChanges(changes, firstFails, { now: new Date() }, 8)).rejects.toThrow(/503/);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let any leftover work run
    // The 8 workers each start one fetch before the failure is seen; none starts another.
    expect(calls).toBe(8);
  });
});

// Which old entry each change is compared with: the same version for tamper
// signals, the entry at the same path for what changed (`from`). Each case is
// one a review found, or one npm writes.
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
    (await vetLockfiles(before, after, registry, { now })).map((r) => ({
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
