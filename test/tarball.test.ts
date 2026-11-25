import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createTarballFetcher } from '../src/tarball.js';
import type { Tarball } from '../src/types/tarball.js';
import {
  createPaxHeader,
  createPaxPath,
  createTgzServer,
  createTarBlocks,
  createTgz,
  type TarEntry,
} from './helpers.js';

const skipWait = () => Promise.resolve();
const createPackageJson = (scripts?: Record<string, unknown>) =>
  JSON.stringify({ name: 'pkg', version: '1.0.0', scripts });

/** A GNU long name (`L`) or long link name (`K`) for the next entry. */
const createLongNameEntry = (type: 'L' | 'K', name: string): TarEntry => ({
  path: '././@LongLink',
  type,
  body: `${name}\0`,
  magic: 'ustar  \0',
});

/** What createTarballFetcher reads from a tarball of `entries`. */
async function fetchEntries(entries: TarEntry[], options?: Parameters<typeof createTgz>[1]) {
  const s = createTgzServer(createTgz(entries, options));
  return createTarballFetcher(s.fetchImpl, skipWait)(s.manifest, 'pkg@1.0.0');
}

// What npm runs comes from the installed files (DESIGN.md, threat model).
describe('createTarballFetcher: what it reads', () => {
  it('reads the install hooks of the root package.json, whatever the first folder is named', async () => {
    const files = await fetchEntries([
      {
        path: 'node/package.json',
        body: createPackageJson({ test: 'vitest', postinstall: 'node x.js' }),
      },
    ]);
    expect(files).toEqual({ scripts: { postinstall: 'node x.js' }, bindingGyp: false });
  });

  it('finds a binding.gyp at the root only', async () => {
    const root = await fetchEntries([
      { path: 'package/package.json', body: createPackageJson() },
      { path: 'package/binding.gyp' },
    ]);
    expect(root).toEqual({ scripts: {}, bindingGyp: true });
    const nested = await fetchEntries([{ path: 'package/src/binding.gyp' }]);
    expect(nested).toEqual({ scripts: {}, bindingGyp: false });
  });

  // A short name keeps the first three letters of the extension.
  it('reads a root file whose short name cannot be that of package.json', async () => {
    const files = await fetchEntries([
      { path: 'package/package.json', body: createPackageJson() },
      { path: 'package/NOTES~1.MD' },
    ]);
    expect(files).toEqual({ scripts: {}, bindingGyp: false });
  });

  // npm runs node-gyp only for a binding.gyp that is a file.
  it('does not count a folder named binding.gyp', async () => {
    const folder = await fetchEntries([{ path: 'package/binding.gyp/', type: '5' }]);
    expect(folder).toEqual({ scripts: {}, bindingGyp: false });
  });

  it('reads a package.json named in a PAX header', async () => {
    const files = await fetchEntries([
      createPaxPath('package/package.json'),
      { path: 'package/other', body: createPackageJson({ preinstall: 'node x.js' }) },
    ]);
    expect(files).toEqual({ scripts: { preinstall: 'node x.js' }, bindingGyp: false });
  });

  // npm leaves links out (pacote).
  it('leaves out links', async () => {
    const files = await fetchEntries([
      { path: 'package/package.json', type: '2', linkpath: 'other.json' },
      { path: 'package/binding.gyp', type: '1', linkpath: 'package/other.gyp' },
      { path: 'package/x', body: createPackageJson({ postinstall: 'node x.js' }) },
    ]);
    expect(files).toEqual({ scripts: {}, bindingGyp: false });
  });

  // As npm reads the installed package.json (read-package-json-fast).
  it('leaves out a hook that is not a string, or is empty', async () => {
    const files = await fetchEntries([
      {
        path: 'package/package.json',
        body: createPackageJson({ install: ['x'], postinstall: '' }),
      },
    ]);
    expect(files).toEqual({ scripts: {}, bindingGyp: false });
  });

  it('reads a tarball once', async () => {
    const s = createTgzServer(
      createTgz([{ path: 'package/package.json', body: createPackageJson() }]),
    );
    const fetchTarball = createTarballFetcher(s.fetchImpl, skipWait);
    await fetchTarball(s.manifest, 'pkg@1.0.0');
    await fetchTarball(s.manifest, 'pkg@1.0.0');
    expect(s.countCalls()).toBe(1);
  });
});

// A tarball bumpvet cannot read is `tarball-not-read` (DESIGN.md, Decisions).
describe('createTarballFetcher: what it does not read', () => {
  const createUnreadTarball = (reason: RegExp) => ({
    unreadReason: expect.stringMatching(reason) as string,
  });

  it.each([
    [
      'a case variant of package.json',
      [{ path: 'package/Package.json', body: createPackageJson() }],
      /another name/,
    ],
    [
      'package.json with a trailing dot',
      [{ path: 'package/package.json.', body: createPackageJson() }],
      /another name/,
    ],
    ['binding.gyp in another Unicode form', [{ path: 'package/ｂinding.gyp' }], /another name/],
    [
      'a name that may be a short name',
      [{ path: 'package/PACKAG~1.JSO', body: createPackageJson() }],
      /short name/,
    ],
    [
      'a short name with a trailing dot',
      [{ path: 'package/PACKAG~1.JSO.', body: createPackageJson() }],
      /short name/,
    ],
    [
      'package.json twice',
      [
        { path: 'package/package.json', body: createPackageJson() },
        { path: 'package/package.json', body: createPackageJson({ postinstall: 'x' }) },
      ],
      /twice/,
    ],
    ['package.json as a folder', [{ path: 'package/package.json/', type: '5' }], /not a file/],
    [
      'package.json that is not JSON',
      [{ path: 'package/package.json', body: '{' }],
      /not valid JSON/,
    ],
    ['an entry type npm does not write', [{ path: 'package/fifo', type: '6' }], /entry type/],
    [
      'a PAX size that differs from the header',
      [
        createPaxHeader([['size', '5']]),
        { path: 'package/package.json', body: createPackageJson() },
      ],
      /PAX size that differs/,
    ],
    [
      'a meta header after a PAX size',
      [
        createPaxHeader([['size', '2']]),
        createLongNameEntry('L', 'package/package.json'),
        { path: 'package/x', body: '{}' },
      ],
      /after a PAX size/,
    ],
    ['a link without a target', [{ path: 'package/l', type: '2' }], /without a target/],
    [
      'a file with a link name in its header',
      [{ path: 'package/package.json', body: createPackageJson(), linkpath: 'y' }],
      /link name on a file/,
    ],
    ['a link without a path', [{ path: '', type: '2', linkpath: 'x' }], /without a path/],
  ] as [string, TarEntry[], RegExp][])('%s', async (_, entries, reason) => {
    expect(await fetchEntries(entries)).toEqual(createUnreadTarball(reason));
  });

  it('a tarball that is not gzipped, or ends inside an entry', async () => {
    expect(
      await fetchEntries([{ path: 'package/package.json', body: createPackageJson() }], {
        gzip: false,
      }),
    ).toEqual(createUnreadTarball(/not a gzip file/));
    const tar = createTgz([{ path: 'package/a', body: 'x'.repeat(2000) }], { gzip: false });
    const cut = createTgzServer(gzipSync(tar.subarray(0, 1024)));
    expect(await createTarballFetcher(cut.fetchImpl, skipWait)(cut.manifest, 'pkg@1.0.0')).toEqual(
      createUnreadTarball(/ends inside an entry/),
    );
    // Without the end-of-archive blocks but whole, as npm reads it.
    expect(await fetchEntries([{ path: 'package/a', body: 'x' }], { end: false })).toEqual({
      scripts: {},
      bindingGyp: false,
    });
  });

  it('a tarball over a limit', async () => {
    const s = createTgzServer(createTgz([{ path: 'package/a', body: 'x'.repeat(10_000) }]));
    const limits = { downloadBytes: 50, unpackedBytes: 512_000_000, fileBytes: 128_000_000 };
    expect(
      await createTarballFetcher(s.fetchImpl, skipWait, limits)(s.manifest, 'pkg@1.0.0'),
    ).toEqual(createUnreadTarball(/over 0.00005 MB to download/));
    const unpacked = { downloadBytes: 256_000_000, unpackedBytes: 5_000, fileBytes: 128_000_000 };
    expect(
      await createTarballFetcher(s.fetchImpl, skipWait, unpacked)(s.manifest, 'pkg@1.0.0'),
    ).toEqual(createUnreadTarball(/unpacked/));
  });

  it('a tarball not on the registry, or not found there', async () => {
    const s = createTgzServer(createTgz([]));
    const fetchTarball = createTarballFetcher(s.fetchImpl, skipWait);
    const elsewhere = {
      ...s.manifest,
      dist: { ...s.manifest.dist, tarball: 'https://evil.example/x.tgz' },
    };
    expect(await fetchTarball(elsewhere, 'pkg@1.0.0')).toEqual(
      createUnreadTarball(/not on the registry/),
    );
  });

  // The registry lists the version: a missing tarball is the registry's fault, not the release's.
  it('retries a tarball the registry does not serve, then fails the run', async () => {
    const s = createTgzServer(createTgz([]));
    const missing = {
      ...s.manifest,
      dist: { ...s.manifest.dist, tarball: `${s.manifest.dist!.tarball!}x` },
    };
    await expect(createTarballFetcher(s.fetchImpl, skipWait)(missing, 'pkg@1.0.0')).rejects.toThrow(
      'registry returned 404 for the tarball of pkg@1.0.0; gave up after 3 attempts',
    );
    expect(s.countCalls()).toBe(3);
  });

  it('checks the hash of a tarball it does not read', async () => {
    const s = createTgzServer(
      createTgz([{ path: 'package/Package.json', body: createPackageJson() }]),
    );
    const wrong = { ...s.manifest, dist: { ...s.manifest.dist, integrity: 'sha512-AAAA' } };
    await expect(createTarballFetcher(s.fetchImpl, skipWait)(wrong, 'pkg@1.0.0')).rejects.toThrow(
      "does not match the registry's hash",
    );
  });

  it('fails the run when the tarball does not match the registry hash', async () => {
    const s = createTgzServer(createTgz([]));
    const wrong = { ...s.manifest, dist: { ...s.manifest.dist, integrity: 'sha512-AAAA' } };
    await expect(createTarballFetcher(s.fetchImpl, skipWait)(wrong, 'pkg@1.0.0')).rejects.toThrow(
      "the tarball of pkg@1.0.0 does not match the registry's hash",
    );
  });
});

/** The part of node-tar's parser that npm's unpacking uses. */
interface NodeTar {
  t(opt: {
    onentry: (entry: ReadEntry) => void;
    onwarn?: () => void;
  }): NodeJS.WritableStream & NodeJS.EventEmitter;
}
interface ReadEntry extends NodeJS.EventEmitter {
  path: string;
  type: string;
  resume(): void;
}
const require = createRequire(import.meta.url);
// The node-tar versions npm 10 and npm 11 and later unpack with (DESIGN.md, threat model).
const nodeTars: [string, NodeTar][] = [
  ['6.2.1', require('tar6') as NodeTar],
  ['7.5.22', require('tar7') as NodeTar],
];

/**
 * What npm installs from `tgz`, read with `tar`'s parser and unpacked as
 * pacote does: the first folder dropped, links left out, paths with `..`
 * skipped, a later entry replacing an earlier one at the same path. Nothing
 * is written to disk. Null when node-tar fails, as npm's install then does.
 */
async function parseInstalledTarball(tgz: Buffer, tar: NodeTar): Promise<Tarball | null> {
  const files = new Map<string, { type: string; body: Buffer }>();
  const parser = tar.t({
    onwarn: () => undefined,
    onentry: (entry) => {
      const parts = entry.path.split('/');
      parts.splice(0, 1);
      const path = parts.join('/').replace(/^\/+/, '').replace(/\/+$/, '');
      if (/Link$/.test(entry.type) || parts.includes('..')) return entry.resume();
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => files.set(path, { type: entry.type, body: Buffer.concat(chunks) }));
    },
  });
  const done = new Promise<boolean>((resolve) => {
    parser.on('end', () => resolve(true));
    parser.on('error', () => resolve(false));
  });
  parser.end(tgz);
  if (!(await done)) return null;
  const pkgJson = files.get('package.json');
  let scripts: Record<string, unknown> = {};
  if (pkgJson && /File$/.test(pkgJson.type)) {
    try {
      // npm's JSON parser drops a byte order mark.
      const parsed = JSON.parse(pkgJson.body.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
      const value = (parsed as { scripts?: unknown } | null)?.scripts;
      if (typeof value === 'object' && value) scripts = value as Record<string, unknown>;
    } catch {
      // npm reads a package.json it cannot parse as one without scripts.
    }
  }
  const hooks: Tarball['scripts'] = {};
  for (const hook of ['preinstall', 'install', 'postinstall'] as const) {
    const value = Object.hasOwn(scripts, hook) ? scripts[hook] : undefined;
    // read-package-json-fast drops a hook that is not a string.
    if (typeof value === 'string' && value) hooks[hook] = value;
  }
  // npm runs node-gyp only for a binding.gyp that is a file (@npmcli/node-gyp).
  const gyp = files.get('binding.gyp');
  return { scripts: hooks, bindingGyp: !!gyp && /File$/.test(gyp.type) };
}

// Forms that node-tar reads leniently, each hiding a package.json from a
// reader that does not read it the same way (DESIGN.md, threat model).
describe('createTarballFetcher: agrees with node-tar', () => {
  /** Whatever bumpvet reads from `tgz`, node-tar unpacks the same; or bumpvet does not read it. */
  async function expectAgreement(tgz: Buffer, label: string) {
    const s = createTgzServer(tgz);
    const ours = await createTarballFetcher(s.fetchImpl, skipWait)(s.manifest, 'pkg@1.0.0');
    if ('unreadReason' in ours) return;
    for (const [version, tar] of nodeTars) {
      const npm = await parseInstalledTarball(tgz, tar);
      if (npm) expect(ours, `${label}, node-tar ${version}`).toEqual(npm);
    }
  }

  const benign = { path: 'package/package.json', body: createPackageJson() };
  const hidden = {
    path: 'package/package.json',
    body: createPackageJson({ postinstall: 'node x.js' }),
  };
  const long = JSON.stringify({
    name: 'pkg',
    description: 'x'.repeat(600),
    scripts: { postinstall: 'node x.js' },
  });

  it.each([
    ['one zero block between two entries', [benign, Buffer.alloc(512), hidden]],
    [
      'a directory with a size, whose body holds an entry',
      [{ path: 'package/d/', type: '5', size: 1024, body: createTarBlocks(hidden) }],
    ],
    [
      'a header with an empty path, whose body holds an entry',
      [{ path: '', size: 1024, body: createTarBlocks(hidden) }],
    ],
    [
      'a prefix under a magic other than ustar 00',
      [{ ...hidden, magic: 'ustar  \0', prefix: 'x' }],
    ],
    // Each of these is not read; without the rule, bumpvet and one node-tar
    // read differently.
    ['a PAX size that differs from the header', [createPaxHeader([['size', '5']]), hidden]],
    [
      'a meta header after a PAX size',
      [
        // Over a block, so that node-tar 6 reads past the long name's body.
        createPaxHeader([['size', String(long.length)]]),
        createLongNameEntry('L', 'package/package.json'),
        { path: 'package/x', body: long },
      ],
    ],
    [
      'a link whose target is only in a PAX header',
      [
        createPaxHeader([['linkpath', 'x']]),
        createLongNameEntry('L', 'package/l'),
        { path: 'package/l', type: '2' },
        hidden,
      ],
    ],
    [
      'a link without a target',
      [benign, { path: 'package/l', type: '2', size: 1024, body: createTarBlocks(hidden) }],
    ],
    [
      'a link without a path',
      [benign, { path: '', type: '2', linkpath: 'x', size: 1024, body: createTarBlocks(hidden) }],
    ],
    ['a PAX header with a link name', [{ ...createPaxPath('package/x'), linkpath: 'y' }, hidden]],
    ['a file with a link name in its header', [{ ...hidden, linkpath: 'y' }]],
    [
      'a long name header without a path, whose body holds an entry',
      [
        { ...createLongNameEntry('L', ''), path: '', size: 1024, body: createTarBlocks(hidden) },
        { path: 'package/x', body: '{}' },
      ],
    ],
    ['a name with a line break after its NUL', [{ ...hidden, path: 'package/package.json\0\nx' }]],
    ['a file with a PAX link name', [createPaxHeader([['linkpath', 'x']]), hidden]],
    [
      'GNU headers throughout',
      [
        { ...benign, magic: 'ustar  \0' },
        { ...hidden, magic: 'ustar  \0' },
      ],
    ],
    [
      'a GNU long name',
      [
        benign,
        createLongNameEntry('L', 'package/package.json'),
        { path: 'package/x', body: createPackageJson({ postinstall: 'node x.js' }) },
      ],
    ],
    [
      'a GNU long link name on a link',
      [createLongNameEntry('K', 'x'.repeat(120)), { path: 'package/l', type: '2' }, hidden],
    ],
    [
      'a PAX size the same as the header',
      [
        createPaxHeader([
          ['path', 'package/package.json'],
          ['size', String(createPackageJson({ postinstall: 'node x.js' }).length)],
        ]),
        { path: 'package/x', body: createPackageJson({ postinstall: 'node x.js' }) },
      ],
    ],
    ['an empty prefix with its 131st byte set', [{ ...hidden, prefix: `${'\0'.repeat(130)}x` }]],
    [
      'a PAX header over 1 MiB',
      [
        createPaxHeader([
          ['path', 'package/x'],
          ['comment', 'c'.repeat(1_100_000)],
        ]),
        hidden,
      ],
    ],
    [
      "one zero block at the end of gunzip's first 16 KiB, then an entry",
      // 1024 + 512 + 14336 bytes before it: the zero block ends at 16384.
      [benign, { path: 'package/a', body: 'x'.repeat(14336) }, Buffer.alloc(512), hidden],
    ],
    [
      'two PAX headers in a row, the second without a path',
      [
        createPaxPath('package/package.json'),
        createPaxHeader([['comment', 'x']]),
        { path: 'package/README', body: createPackageJson({ postinstall: 'node x.js' }) },
      ],
    ],
    [
      'a PAX length with a leading zero',
      [
        { path: 'PaxHeader', type: 'x', body: '030 path=package/package.json\n' },
        { path: 'package/README', body: createPackageJson({ postinstall: 'node x.js' }) },
      ],
    ],
    [
      'a path with an empty part',
      [
        benign,
        { path: 'package//package.json', body: createPackageJson({ postinstall: 'node x.js' }) },
      ],
    ],
    [
      'a PAX record with a line break in its value',
      [
        {
          path: 'PaxHeader',
          type: 'x',
          body: (() => {
            const rest = 'x\n29 path=package/package.json\n';
            const createRecord = (len: number) => `${len} comment=${rest}`;
            let len = createRecord(0).length;
            while (createRecord(len).length !== len) len = createRecord(len).length;
            return createRecord(len);
          })(),
        },
        { path: 'package/README', body: createPackageJson({ postinstall: 'node x.js' }) },
      ],
    ],
  ] as [string, (TarEntry | Buffer)[]][])('%s', async (label, entries) => {
    await expectAgreement(createTgz(entries), label);
  });

  // Seeded, so that a failure can be replayed.
  it('agrees on tarballs with random damage', async () => {
    let seed = 20261103;
    const drawRandom = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const drawInt = (n: number) => Math.floor(drawRandom() * n);
    const bases = [
      [benign, { path: 'package/index.js', body: 'module.exports = 1' }],
      [{ path: 'package/', type: '5' }, hidden, { path: 'package/binding.gyp', body: '{}' }],
      [createPaxPath(`package/${'d'.repeat(120)}/package.json`), hidden, benign],
      [benign, { path: 'package/lib/', type: '5' }, { path: 'package/lib/a.js', body: 'x' }],
    ]
      .map((entries) => createTgz(entries as TarEntry[], { gzip: false }))
      .concat(PACKERS.map((tool) => gunzipSync(readPacked(tool))));
    for (let n = 0; n < 2000; n++) {
      const tar = Buffer.from(bases[drawInt(bases.length)]!);
      const blocks = tar.length / 512;
      const kind = drawInt(6);
      let damaged: Buffer;
      if (kind === 0) {
        // A byte anywhere, most often in a header's fields.
        const block = drawInt(blocks) * 512;
        tar[block + (drawRandom() < 0.8 ? drawInt(345) : drawInt(512))] = drawInt(256);
        // Half the time with the checksum made right again, so node-tar reads the header.
        if (drawRandom() < 0.5) {
          tar.fill(0x20, block + 148, block + 156);
          const sum = tar.subarray(block, block + 512).reduce((n, b) => n + b, 0);
          tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, block + 148, 'latin1');
        }
        damaged = tar;
      } else if (kind === 1) {
        // A zero block put in.
        const at = drawInt(blocks) * 512;
        damaged = Buffer.concat([tar.subarray(0, at), Buffer.alloc(512), tar.subarray(at)]);
      } else if (kind === 2) {
        // A block repeated.
        const at = drawInt(blocks) * 512;
        damaged = Buffer.concat([tar.subarray(0, at + 512), tar.subarray(at)]);
      } else if (kind === 3) {
        // Cut at a block.
        damaged = tar.subarray(0, drawInt(blocks) * 512);
      } else {
        // The gzip itself: a second one after it, or bytes after it.
        const other = bases[drawInt(bases.length)]!;
        const tail =
          kind === 4 ? gzipSync(other) : Buffer.from([drawInt(256), drawInt(256), drawInt(256)]);
        await expectAgreement(Buffer.concat([gzipSync(tar), tail]), `damage ${n} (kind ${kind})`);
        continue;
      }
      await expectAgreement(gzipSync(damaged), `damage ${n} (kind ${kind})`);
    }
  });
});

// One package (install hooks, a root binding.gyp, a path and a file name over
// 100 characters, links) as npm 10.8.2, pnpm 12.16.1, yarn 4.18.1 and bun 1.4.4
// pack it; yarn-long-link adds a link whose target is over 100 characters.
const PACKERS = ['npm', 'pnpm', 'yarn', 'bun'];
function readPacked(name: string): Buffer {
  return readFileSync(new URL(`fixtures/packers/${name}.tgz`, import.meta.url));
}

describe('createTarballFetcher: what packers write', () => {
  it.each(PACKERS)('reads what %s packs, as node-tar 6 and 7 read it', async (tool) => {
    const tgz = readPacked(tool);
    const s = createTgzServer(tgz);
    const ours = await createTarballFetcher(s.fetchImpl, skipWait)(s.manifest, 'pkg@1.0.0');
    expect(ours).toEqual({ scripts: { postinstall: 'node x.js' }, bindingGyp: true });
    for (const [version, tar] of nodeTars) {
      expect(await parseInstalledTarball(tgz, tar), `node-tar ${version}`).toEqual(ours);
    }
  });

  // yarn puts the link name on the PAX header too, which node-tar 6 skips and
  // node-tar 7 reads.
  it('does not read a link whose PAX header has a link name, as yarn writes a long one', async () => {
    const s = createTgzServer(readPacked('yarn-long-link'));
    expect(await createTarballFetcher(s.fetchImpl, skipWait)(s.manifest, 'pkg@1.0.0')).toEqual({
      unreadReason: expect.stringMatching(/link name on a meta header/) as string,
    });
  });
});
