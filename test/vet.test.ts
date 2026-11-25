import { describe, expect, it } from 'vitest';
import { vetChanges, vetLockfiles } from '../src/vet.js';
import type { PackumentFetcher } from '../src/types/registry.js';
import type { TarballFetcher } from '../src/types/tarball.js';
import {
  createFakeRegistry,
  createLockfile,
  createPackument,
  fetchPublishedTarball,
} from './helpers.js';

describe('vetChanges', () => {
  it('gives each result the paths of its change', async () => {
    const changes = [
      {
        name: 'a',
        from: null,
        to: '1.0.0',
        paths: ['node_modules/a', 'node_modules/x/node_modules/a'],
      },
      { name: 'b', from: null, to: '1.0.0' },
    ];
    const results = await vetChanges(changes, () => Promise.resolve(null), fetchPublishedTarball, {
      now: new Date(),
    });
    expect(results.map((r) => r.paths)).toEqual([
      ['node_modules/a', 'node_modules/x/node_modules/a'],
      undefined,
    ]);
  });

  it('starts no more fetches after one fails', async () => {
    const changes = Array.from({ length: 20 }, (_, i) => ({
      name: `p${i}`,
      from: null,
      to: '1.0.0',
    }));
    let calls = 0;
    // Only the first fetch fails; without the stop, the other workers would go on through all 20.
    const fetchFailingFirst = () =>
      ++calls === 1 ? Promise.reject(new Error('registry returned 503')) : Promise.resolve(null);
    await expect(
      vetChanges(changes, fetchFailingFirst, fetchPublishedTarball, { now: new Date() }, 8),
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
      vetChanges(changes, fetchPackument, fetchPublishedTarball, { now: new Date() }, 8),
    ).rejects.toThrow(/503/);
    expect(signals).toHaveLength(8);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});

// The tarballs of the new version and the one it is compared with are read;
// not when the lockfile already installs something else (DESIGN.md, Decisions).
describe('vetChanges: which tarballs are read', () => {
  const fetchPackument = createFakeRegistry(
    createPackument('pkg', [
      { version: '1.0.0', time: '2025-01-01T00:00:00Z', publisher: 'alice' },
      { version: '1.1.0', time: '2025-02-01T00:00:00Z', publisher: 'alice', bindingGyp: true },
    ]),
  );
  const now = new Date('2026-01-01T00:00:00Z');
  const createTarballRecorder = (fetchTarballImpl: TarballFetcher = fetchPublishedTarball) => {
    const read: string[] = [];
    const fetchTarball: TarballFetcher = (manifest, what, signal) => {
      read.push(what);
      return fetchTarballImpl(manifest, what, signal);
    };
    return { read, fetchTarball };
  };
  const update = { name: 'pkg', from: '1.0.0', to: '1.1.0', integrity: 'sha512-pkg-1.1.0' };

  it('reads the new version and the one it is compared with, and reports what changed', async () => {
    const { read, fetchTarball } = createTarballRecorder();
    const [r] = await vetChanges([update], fetchPackument, fetchTarball, { now });
    expect(read).toEqual(['pkg@1.1.0', 'pkg@1.0.0']);
    expect(r?.signals.map((s) => [s.id, s.before, s.after])).toEqual([
      ['install-scripts', 'binding.gyp: none', 'binding.gyp: present'],
    ]);
  });

  it('reads only the new version of a package with nothing before it', async () => {
    const { read, fetchTarball } = createTarballRecorder();
    const change = { name: 'pkg', from: null, to: '1.0.0', integrity: 'sha512-pkg-1.0.0' };
    await vetChanges([change], fetchPackument, fetchTarball, { now });
    expect(read).toEqual(['pkg@1.0.0']);
  });

  it('does not read a tarball the lockfile does not install', async () => {
    const { read, fetchTarball } = createTarballRecorder();
    const changes = [
      { name: 'pkg', from: null, to: '1.0.0', integrity: 'sha512-other' },
      { name: 'pkg', from: null, to: '9.9.9' },
      { name: 'pkg', from: null, to: '1.0.0', source: 'git+https://example.com/x.git' },
    ];
    const results = await vetChanges(changes, fetchPackument, fetchTarball, { now });
    expect(results.map((r) => r.signals.map((s) => s.id))).toEqual([
      ['integrity-mismatch'],
      ['not-in-registry'],
      ['not-from-registry'],
    ]);
    expect(read).toEqual([]);
  });

  it('does not look up an entry it cannot read, whose name may not be a package name', async () => {
    const looked: string[] = [];
    const fetchRecordingLookups: PackumentFetcher = (name, signal) => {
      looked.push(name);
      return fetchPackument(name, signal);
    };
    const { read, fetchTarball } = createTarballRecorder();
    const change = {
      name: '../evil',
      from: null,
      to: '1.0.0',
      problem: 'invalid package name "../evil"',
    };
    const [r] = await vetChanges([change], fetchRecordingLookups, fetchTarball, { now });
    expect(looked).toEqual([]);
    expect(read).toEqual([]);
    expect(r?.signals.map((s) => s.id)).toEqual(['not-from-registry']);
  });

  it('does not read the compared version when the new one was not read', async () => {
    const { read, fetchTarball } = createTarballRecorder(() =>
      Promise.resolve({ unreadReason: 'over 256 MB to download' }),
    );
    const [r] = await vetChanges([update], fetchPackument, fetchTarball, { now });
    expect(read).toEqual(['pkg@1.1.0']);
    expect(r?.signals.map((s) => s.id)).toEqual(['tarball-not-read']);
  });
});

// Which old entry each change is compared with: the same version for tamper
// signals, the entry at the same path for what changed (`from`).
describe('vetLockfiles: what a change is compared with', () => {
  const now = new Date('2026-01-10T00:00:00Z');
  const createMonthTime = (month: number) => `2025-${String(month).padStart(2, '0')}-01T00:00:00Z`;
  const fetchPackument = createFakeRegistry(
    createPackument('semver', [
      { version: '6.3.1', time: createMonthTime(1), publisher: 'alice' },
      {
        version: '7.6.0',
        time: createMonthTime(2),
        publisher: 'alice',
        scripts: { postinstall: 'x' },
      },
    ]),
    createPackument('x', [
      { version: '1.0.0', time: createMonthTime(1), publisher: 'alice' },
      { version: '2.0.0', time: createMonthTime(2), publisher: 'alice' },
    ]),
    createPackument('y', [{ version: '1.2.0', time: createMonthTime(1), publisher: 'alice' }]),
    createPackument('parent', [
      { version: '1.0.0', time: createMonthTime(1), publisher: 'alice' },
      { version: '2.0.0', time: createMonthTime(2), publisher: 'alice' },
    ]),
  );
  const vetLockfileTexts = async (before: string, after: string) =>
    (await vetLockfiles(before, after, fetchPackument, fetchPublishedTarball, { now })).map(
      (r) => ({
        name: r.name,
        from: r.from,
        to: r.to,
        signals: r.signals.map((s) => s.id),
      }),
    );
  const unpinned = { integrity: undefined, resolved: undefined };

  it('compares an upgrade with the entry at its path, not a bundled copy of the new version', async () => {
    const bundled = { version: '7.6.0', ...unpinned };
    const before = createLockfile({
      'node_modules/semver': { version: '6.3.1' },
      'node_modules/npm/node_modules/semver': bundled,
    });
    const after = createLockfile({
      'node_modules/semver': { version: '7.6.0' },
      'node_modules/npm/node_modules/semver': bundled,
    });
    expect(await vetLockfileTexts(before, after)).toEqual([
      { name: 'semver', from: '6.3.1', to: '7.6.0', signals: ['install-scripts'] },
    ]);
  });

  describe('links', () => {
    const createAppLockfile = (packages: Record<string, unknown>) =>
      JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...packages } });
    const createLinkEntry = (resolved: string) => ({ resolved, link: true });
    /** A registry entry as createLockfile() writes it. */
    const createLockfileEntry = (name: string, version: string) =>
      (
        JSON.parse(createLockfile({ [`node_modules/${name}`]: { version } })) as {
          packages: Record<string, object>;
        }
      ).packages[`node_modules/${name}`]!;

    it('blocks a registry package replaced by a link', async () => {
      const before = createLockfile({ 'node_modules/x': { version: '1.0.0' } });
      const after = createAppLockfile({
        'node_modules/x': createLinkEntry('vendor/x'),
        'vendor/x': { version: '1.0.0' },
      });
      const [result] = await vetLockfiles(before, after, fetchPackument, fetchPublishedTarball, {
        now,
      });
      expect(result?.verdict).toBe('block');
      expect(result?.signals).toEqual([
        {
          id: 'source-changed',
          group: 'tamper',
          before: 'npm registry',
          after: 'link to vendor/x',
        },
      ]);
    });

    it('asks for a review of a new link', async () => {
      const after = createAppLockfile({
        'node_modules/lib': createLinkEntry('packages/lib'),
        'packages/lib': { version: '1.0.0' },
      });
      const [result] = await vetLockfiles(
        createAppLockfile({}),
        after,
        fetchPackument,
        fetchPublishedTarball,
        { now },
      );
      expect(result?.verdict).toBe('review');
      expect(result?.signals).toEqual([
        {
          id: 'not-from-registry',
          group: 'origin',
          before: 'not installed',
          after: 'link to packages/lib',
        },
      ]);
    });

    it('asks for a review of a link that points somewhere else', async () => {
      const before = createAppLockfile({ 'node_modules/lib': createLinkEntry('packages/lib') });
      const after = createAppLockfile({ 'node_modules/lib': createLinkEntry('vendor/lib') });
      const [result] = await vetLockfiles(before, after, fetchPackument, fetchPublishedTarball, {
        now,
      });
      expect(result?.verdict).toBe('review');
      expect(result?.signals[0]?.id).toBe('not-from-registry');
    });

    it('says nothing of a link whose workspace only changed version', async () => {
      const before = createAppLockfile({
        'node_modules/lib': createLinkEntry('packages/lib'),
        'packages/lib': { version: '1.0.0' },
      });
      const after = createAppLockfile({
        'node_modules/lib': createLinkEntry('packages/lib'),
        'packages/lib': { version: '1.1.0' },
      });
      expect(await vetLockfileTexts(before, after)).toEqual([]);
    });

    it('vets a registry package that replaced a link as a new package', async () => {
      const before = createAppLockfile({ 'node_modules/x': createLinkEntry('vendor/x') });
      const after = createLockfile({ 'node_modules/x': { version: '2.0.0' } });
      expect(await vetLockfileTexts(before, after)).toEqual([
        { name: 'x', from: null, to: '2.0.0', signals: [] },
      ]);
    });

    it('compares a registry package with the old registry version, not with a link of its name', async () => {
      const before = createAppLockfile({
        'node_modules/semver': createLinkEntry('vendor/semver'),
        'node_modules/a/node_modules/semver': createLockfileEntry('semver', '6.3.1'),
      });
      const after = createAppLockfile({
        'node_modules/semver': createLinkEntry('vendor/semver'),
        'node_modules/b/node_modules/semver': createLockfileEntry('semver', '7.6.0'),
      });
      expect(await vetLockfileTexts(before, after)).toEqual([
        { name: 'semver', from: '6.3.1', to: '7.6.0', signals: ['install-scripts'] },
      ]);
    });

    it('does not count an entry it could not read before as coming from the registry', async () => {
      const before = createAppLockfile({
        'node_modules/x': { link: true },
        'node_modules/y': { ...createLockfileEntry('y', '1.0.0'), integrity: 5 },
      });
      const after = createAppLockfile({
        'node_modules/x': createLinkEntry('vendor/x'),
        'node_modules/y': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/y.git#abc' },
      });
      expect(await vetLockfileTexts(before, after)).toEqual([
        {
          name: 'x',
          from: 'link to nothing',
          to: 'link to vendor/x',
          signals: ['not-from-registry'],
        },
        { name: 'y', from: '1.0.0', to: '1.0.0', signals: ['not-from-registry'] },
      ]);
    });

    it('blocks a registry package replaced by a link another path already has', async () => {
      const before = createAppLockfile({
        'node_modules/x': createLockfileEntry('x', '1.0.0'),
        'node_modules/a/node_modules/x': createLinkEntry('vendor/x'),
      });
      const after = createAppLockfile({
        'node_modules/x': createLinkEntry('vendor/x'),
        'node_modules/a/node_modules/x': createLinkEntry('vendor/x'),
      });
      expect((await vetLockfileTexts(before, after))[0]?.signals).toEqual(['source-changed']);
    });

    it('blocks a registry package replaced by a link when another path has a different one', async () => {
      const before = createAppLockfile({
        'node_modules/x': createLockfileEntry('x', '1.0.0'),
        'node_modules/a/node_modules/x': createLinkEntry('vendor/other'),
      });
      const after = createAppLockfile({
        'node_modules/x': createLinkEntry('vendor/evil'),
        'node_modules/a/node_modules/x': createLinkEntry('vendor/other'),
      });
      expect(await vetLockfileTexts(before, after)).toEqual([
        { name: 'x', from: '1.0.0', to: 'link to vendor/evil', signals: ['source-changed'] },
      ]);
    });

    it('blocks an aliased registry package replaced by a link', async () => {
      const before = createAppLockfile({
        'node_modules/my-x': { ...createLockfileEntry('x', '1.0.0'), name: 'x' },
      });
      const after = createAppLockfile({ 'node_modules/my-x': createLinkEntry('vendor/x') });
      expect((await vetLockfileTexts(before, after))[0]?.signals).toEqual(['source-changed']);
    });

    it('asks for a review of a new link whose name a nested package has', async () => {
      const nested = { 'node_modules/a/node_modules/x': createLockfileEntry('x', '1.0.0') };
      const before = createAppLockfile(nested);
      const after = createAppLockfile({
        ...nested,
        'node_modules/x': createLinkEntry('packages/x'),
      });
      expect(await vetLockfileTexts(before, after)).toEqual([
        { name: 'x', from: null, to: 'link to packages/x', signals: ['not-from-registry'] },
      ]);
    });

    it('reports a link to another target when a field of the wrong type stays the same', async () => {
      const before = createAppLockfile({
        'node_modules/x': { ...createLinkEntry('vendor/a'), version: 1 },
      });
      const after = createAppLockfile({
        'node_modules/x': { ...createLinkEntry('vendor/evil'), version: 1 },
      });
      expect((await vetLockfileTexts(before, after))[0]?.to).toBe('link to vendor/evil');
    });

    it('reports a link to another target when the path gives an invalid name', async () => {
      const before = createAppLockfile({ 'node_modules/.x': createLinkEntry('vendor/a') });
      const after = createAppLockfile({ 'node_modules/.x': createLinkEntry('vendor/evil') });
      expect((await vetLockfileTexts(before, after))[0]?.to).toBe('link to vendor/evil');
    });

    it('lists the same new link at two paths once', async () => {
      const after = createAppLockfile({
        'packages/a/node_modules/lib': createLinkEntry('packages/lib'),
        'packages/b/node_modules/lib': createLinkEntry('packages/lib'),
      });
      expect(await vetLockfileTexts(createAppLockfile({}), after)).toHaveLength(1);
    });

    it('blocks a registry entry given a `link` of another type, with nothing else changed', async () => {
      const before = createAppLockfile({ 'node_modules/x': createLockfileEntry('x', '1.0.0') });
      const after = createAppLockfile({
        'node_modules/x': { ...createLockfileEntry('x', '1.0.0'), link: 1 },
      });
      expect((await vetLockfileTexts(before, after))[0]?.signals).toEqual(['source-changed']);
    });
  });

  it('flags a version that came from the registry elsewhere and now comes from another server', async () => {
    const before = createLockfile({
      'node_modules/x': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/x.git#aaa' },
      'node_modules/a/node_modules/x': { version: '2.0.0' },
    });
    const after = createLockfile({
      'node_modules/x': { version: '2.0.0', resolved: 'https://evil.example/x.tgz' },
      'node_modules/a/node_modules/x': { version: '2.0.0' },
    });
    expect((await vetLockfileTexts(before, after))[0]?.signals).toEqual(['source-changed']);
  });

  it('compares the integrity of a version with the old copy of that version', async () => {
    const before = createLockfile({
      'node_modules/x': { version: '1.0.0' },
      'node_modules/a/node_modules/x': { version: '2.0.0', integrity: 'sha512-old' },
    });
    const after = createLockfile({
      'node_modules/x': { version: '2.0.0' },
      'node_modules/a/node_modules/x': { version: '2.0.0', integrity: 'sha512-old' },
    });
    expect((await vetLockfileTexts(before, after))[0]?.signals).toEqual(['integrity-mismatch']);
  });

  it('passes a dependency npm starts to bundle, which loses its integrity', async () => {
    const before = createLockfile({
      'node_modules/parent': { version: '1.0.0' },
      'node_modules/parent/node_modules/y': { version: '1.2.0' },
    });
    const after = createLockfile({
      'node_modules/parent': { version: '2.0.0' },
      'node_modules/parent/node_modules/y': { version: '1.2.0', ...unpinned },
    });
    expect(await vetLockfileTexts(before, after)).toEqual([
      { name: 'parent', from: '1.0.0', to: '2.0.0', signals: [] },
      { name: 'y', from: '1.2.0', to: '1.2.0', signals: [] },
    ]);
  });

  it('keeps the comparison with each earlier version of a new version at several paths', async () => {
    const fetchPackumentA = createFakeRegistry(
      createPackument('a', [
        { version: '0.9.0', time: createMonthTime(1), publisher: 'alice', provenance: true },
        {
          version: '1.0.0',
          time: createMonthTime(2),
          publisher: 'alice',
          scripts: { postinstall: 'x' },
        },
        {
          version: '2.0.0',
          time: createMonthTime(3),
          publisher: 'alice',
          scripts: { postinstall: 'x' },
        },
      ]),
    );
    const before = createLockfile({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b/node_modules/a': { version: '0.9.0' },
    });
    const after = createLockfile({
      'node_modules/a': { version: '2.0.0' },
      'node_modules/b/node_modules/a': { version: '2.0.0' },
    });
    const results = await vetLockfiles(before, after, fetchPackumentA, fetchPublishedTarball, {
      now,
    });
    expect(results.map((r) => [r.from, r.verdict])).toEqual([
      ['1.0.0', 'ok'],
      ['0.9.0', 'block'],
    ]);
  });

  // npm fetches it from the registry by name and version (DESIGN.md, threat model);
  // the configured registry is issue #17.
  it('passes an entry that lost both `resolved` and its integrity', async () => {
    const before = createLockfile({ 'node_modules/y': { version: '1.2.0' } });
    const after = createLockfile({ 'node_modules/y': { version: '1.2.0', ...unpinned } });
    expect(await vetLockfileTexts(before, after)).toEqual([
      { name: 'y', from: '1.2.0', to: '1.2.0', signals: [] },
    ]);
  });
});
