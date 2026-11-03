import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { tarballFetcher } from '../src/tarball.js';
import type { Tarball } from '../src/types/tarball.js';
import { paxHeader, paxPath, served, tarBlocks, tarball, type TarEntry } from './helpers.js';

const noWait = () => Promise.resolve();
const pkg = (scripts?: Record<string, unknown>) =>
  JSON.stringify({ name: 'pkg', version: '1.0.0', scripts });

/** A GNU long name (`L`) or long link name (`K`) for the next entry. */
const longName = (type: 'L' | 'K', name: string): TarEntry => ({
  path: '././@LongLink',
  type,
  body: `${name}\0`,
  magic: 'ustar  \0',
});

/** What tarballFetcher reads from a tarball of `entries`. */
async function read(entries: TarEntry[], options?: Parameters<typeof tarball>[1]) {
  const s = served(tarball(entries, options));
  return tarballFetcher(s.fetchImpl, noWait)(s.manifest, 'pkg@1.0.0');
}

// What npm runs comes from the installed files (DESIGN.md, threat model).
describe('tarballFetcher: what it reads', () => {
  it('reads the install hooks of the root package.json, whatever the first folder is named', async () => {
    const files = await read([
      { path: 'node/package.json', body: pkg({ test: 'vitest', postinstall: 'node x.js' }) },
    ]);
    expect(files).toEqual({ scripts: { postinstall: 'node x.js' }, bindingGyp: false });
  });

  it('finds a binding.gyp at the root only', async () => {
    const root = await read([
      { path: 'package/package.json', body: pkg() },
      { path: 'package/binding.gyp' },
    ]);
    expect(root).toEqual({ scripts: {}, bindingGyp: true });
    const nested = await read([{ path: 'package/src/binding.gyp' }]);
    expect(nested).toEqual({ scripts: {}, bindingGyp: false });
  });

  // A short name keeps the first three letters of the extension.
  it('reads a root file whose short name cannot be that of package.json', async () => {
    const files = await read([
      { path: 'package/package.json', body: pkg() },
      { path: 'package/NOTES~1.MD' },
    ]);
    expect(files).toEqual({ scripts: {}, bindingGyp: false });
  });

  // npm runs node-gyp only for a binding.gyp that is a file.
  it('does not count a folder named binding.gyp', async () => {
    const folder = await read([{ path: 'package/binding.gyp/', type: '5' }]);
    expect(folder).toEqual({ scripts: {}, bindingGyp: false });
  });

  it('reads a package.json named in a PAX header', async () => {
    const files = await read([
      paxPath('package/package.json'),
      { path: 'package/other', body: pkg({ preinstall: 'node x.js' }) },
    ]);
    expect(files).toEqual({ scripts: { preinstall: 'node x.js' }, bindingGyp: false });
  });

  // npm leaves links out (pacote).
  it('leaves out links', async () => {
    const files = await read([
      { path: 'package/package.json', type: '2', linkpath: 'other.json' },
      { path: 'package/binding.gyp', type: '1', linkpath: 'package/other.gyp' },
      { path: 'package/x', body: pkg({ postinstall: 'node x.js' }) },
    ]);
    expect(files).toEqual({ scripts: {}, bindingGyp: false });
  });

  // As npm reads the installed package.json (read-package-json-fast).
  it('leaves out a hook that is not a string, or is empty', async () => {
    const files = await read([
      { path: 'package/package.json', body: pkg({ install: ['x'], postinstall: '' }) },
    ]);
    expect(files).toEqual({ scripts: {}, bindingGyp: false });
  });

  it('reads a tarball once', async () => {
    const s = served(tarball([{ path: 'package/package.json', body: pkg() }]));
    const get = tarballFetcher(s.fetchImpl, noWait);
    await get(s.manifest, 'pkg@1.0.0');
    await get(s.manifest, 'pkg@1.0.0');
    expect(s.calls()).toBe(1);
  });
});

// A tarball bumpvet cannot read is `tarball-not-read` (DESIGN.md, Decisions).
describe('tarballFetcher: what it does not read', () => {
  const notChecked = (reason: RegExp) => ({ notChecked: expect.stringMatching(reason) as string });

  it.each([
    [
      'a case variant of package.json',
      [{ path: 'package/Package.json', body: pkg() }],
      /another name/,
    ],
    [
      'package.json with a trailing dot',
      [{ path: 'package/package.json.', body: pkg() }],
      /another name/,
    ],
    ['binding.gyp in another Unicode form', [{ path: 'package/ｂinding.gyp' }], /another name/],
    [
      'a name that may be a short name',
      [{ path: 'package/PACKAG~1.JSO', body: pkg() }],
      /short name/,
    ],
    [
      'a short name with a trailing dot',
      [{ path: 'package/PACKAG~1.JSO.', body: pkg() }],
      /short name/,
    ],
    [
      'package.json twice',
      [
        { path: 'package/package.json', body: pkg() },
        { path: 'package/package.json', body: pkg({ postinstall: 'x' }) },
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
      [paxHeader([['size', '5']]), { path: 'package/package.json', body: pkg() }],
      /PAX size that differs/,
    ],
    [
      'a meta header after a PAX size',
      [
        paxHeader([['size', '2']]),
        longName('L', 'package/package.json'),
        { path: 'package/x', body: '{}' },
      ],
      /after a PAX size/,
    ],
    ['a link without a target', [{ path: 'package/l', type: '2' }], /without a target/],
    [
      'a file with a link name in its header',
      [{ path: 'package/package.json', body: pkg(), linkpath: 'y' }],
      /link name on a file/,
    ],
    ['a link without a path', [{ path: '', type: '2', linkpath: 'x' }], /without a path/],
  ] as [string, TarEntry[], RegExp][])('%s', async (_, entries, reason) => {
    expect(await read(entries)).toEqual(notChecked(reason));
  });

  it('a tarball that is not gzipped, or ends inside an entry', async () => {
    expect(await read([{ path: 'package/package.json', body: pkg() }], { gzip: false })).toEqual(
      notChecked(/not a gzip file/),
    );
    const tar = tarball([{ path: 'package/a', body: 'x'.repeat(2000) }], { gzip: false });
    const cut = served(gzipSync(tar.subarray(0, 1024)));
    expect(await tarballFetcher(cut.fetchImpl, noWait)(cut.manifest, 'pkg@1.0.0')).toEqual(
      notChecked(/ends inside an entry/),
    );
    // Without the end-of-archive blocks but whole, as npm reads it.
    expect(await read([{ path: 'package/a', body: 'x' }], { end: false })).toEqual({
      scripts: {},
      bindingGyp: false,
    });
  });

  it('a tarball over a limit', async () => {
    const s = served(tarball([{ path: 'package/a', body: 'x'.repeat(10_000) }]));
    const limits = { downloadBytes: 50, unpackedBytes: 512_000_000, fileBytes: 128_000_000 };
    expect(await tarballFetcher(s.fetchImpl, noWait, limits)(s.manifest, 'pkg@1.0.0')).toEqual(
      notChecked(/over 0.00005 MB to download/),
    );
    const unpacked = { downloadBytes: 256_000_000, unpackedBytes: 5_000, fileBytes: 128_000_000 };
    expect(await tarballFetcher(s.fetchImpl, noWait, unpacked)(s.manifest, 'pkg@1.0.0')).toEqual(
      notChecked(/unpacked/),
    );
  });

  it('a tarball not on the registry, or not found there', async () => {
    const s = served(tarball([]));
    const get = tarballFetcher(s.fetchImpl, noWait);
    const elsewhere = {
      ...s.manifest,
      dist: { ...s.manifest.dist, tarball: 'https://evil.example/x.tgz' },
    };
    expect(await get(elsewhere, 'pkg@1.0.0')).toEqual(notChecked(/not on the registry/));
  });

  // The registry lists the version: a missing tarball is the registry's fault, not the release's.
  it('retries a tarball the registry does not serve, then fails the run', async () => {
    const s = served(tarball([]));
    const missing = {
      ...s.manifest,
      dist: { ...s.manifest.dist, tarball: `${s.manifest.dist!.tarball!}x` },
    };
    await expect(tarballFetcher(s.fetchImpl, noWait)(missing, 'pkg@1.0.0')).rejects.toThrow(
      'registry returned 404 for the tarball of pkg@1.0.0; gave up after 3 attempts',
    );
    expect(s.calls()).toBe(3);
  });

  it('checks the hash of a tarball it does not read', async () => {
    const s = served(tarball([{ path: 'package/Package.json', body: pkg() }]));
    const wrong = { ...s.manifest, dist: { ...s.manifest.dist, integrity: 'sha512-AAAA' } };
    await expect(tarballFetcher(s.fetchImpl, noWait)(wrong, 'pkg@1.0.0')).rejects.toThrow(
      "does not match the registry's hash",
    );
  });

  it('fails the run when the tarball does not match the registry hash', async () => {
    const s = served(tarball([]));
    const wrong = { ...s.manifest, dist: { ...s.manifest.dist, integrity: 'sha512-AAAA' } };
    await expect(tarballFetcher(s.fetchImpl, noWait)(wrong, 'pkg@1.0.0')).rejects.toThrow(
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
const NODE_TARS: [string, NodeTar][] = [
  ['6.2.1', require('tar6') as NodeTar],
  ['7.5.22', require('tar7') as NodeTar],
];

/**
 * What npm installs from `tgz`, read with `tar`'s parser and unpacked as
 * pacote does: the first folder dropped, links left out, paths with `..`
 * skipped, a later entry replacing an earlier one at the same path. Nothing
 * is written to disk. Null when node-tar fails, as npm's install then does.
 */
async function npmReads(tgz: Buffer, tar: NodeTar): Promise<Tarball | null> {
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

/** Whatever bumpvet reads from `tgz`, node-tar unpacks the same; or bumpvet does not read it. */
async function expectAgreement(tgz: Buffer, label: string) {
  const s = served(tgz);
  const ours = await tarballFetcher(s.fetchImpl, noWait)(s.manifest, 'pkg@1.0.0');
  if ('notChecked' in ours) return;
  for (const [version, tar] of NODE_TARS) {
    const npm = await npmReads(tgz, tar);
    if (npm) expect(ours, `${label}, node-tar ${version}`).toEqual(npm);
  }
}

const benign = { path: 'package/package.json', body: pkg() };
const hidden = { path: 'package/package.json', body: pkg({ postinstall: 'node x.js' }) };
const long = JSON.stringify({
  name: 'pkg',
  description: 'x'.repeat(600),
  scripts: { postinstall: 'node x.js' },
});

// Forms that node-tar reads leniently, each hiding a package.json from a
// reader that does not read it the same way (DESIGN.md, threat model).
describe('tarballFetcher: agrees with node-tar', () => {
  it.each([
    ['one zero block between two entries', [benign, Buffer.alloc(512), hidden]],
    [
      'a directory with a size, whose body holds an entry',
      [{ path: 'package/d/', type: '5', size: 1024, body: tarBlocks(hidden) }],
    ],
    [
      'a header with an empty path, whose body holds an entry',
      [{ path: '', size: 1024, body: tarBlocks(hidden) }],
    ],
    [
      'a prefix under a magic other than ustar 00',
      [{ ...hidden, magic: 'ustar  \0', prefix: 'x' }],
    ],
    // Each of these is not read; without the rule, bumpvet and one node-tar
    // read differently.
    ['a PAX size that differs from the header', [paxHeader([['size', '5']]), hidden]],
    [
      'a meta header after a PAX size',
      [
        // Over a block, so that node-tar 6 reads past the long name's body.
        paxHeader([['size', String(long.length)]]),
        longName('L', 'package/package.json'),
        { path: 'package/x', body: long },
      ],
    ],
    [
      'a link whose target is only in a PAX header',
      [
        paxHeader([['linkpath', 'x']]),
        longName('L', 'package/l'),
        { path: 'package/l', type: '2' },
        hidden,
      ],
    ],
    [
      'a link without a target',
      [benign, { path: 'package/l', type: '2', size: 1024, body: tarBlocks(hidden) }],
    ],
    [
      'a link without a path',
      [benign, { path: '', type: '2', linkpath: 'x', size: 1024, body: tarBlocks(hidden) }],
    ],
    ['a PAX header with a link name', [{ ...paxPath('package/x'), linkpath: 'y' }, hidden]],
    ['a file with a link name in its header', [{ ...hidden, linkpath: 'y' }]],
    [
      'a long name header without a path, whose body holds an entry',
      [
        { ...longName('L', ''), path: '', size: 1024, body: tarBlocks(hidden) },
        { path: 'package/x', body: '{}' },
      ],
    ],
    ['a name with a line break after its NUL', [{ ...hidden, path: 'package/package.json\0\nx' }]],
    ['a file with a PAX link name', [paxHeader([['linkpath', 'x']]), hidden]],
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
        longName('L', 'package/package.json'),
        { path: 'package/x', body: pkg({ postinstall: 'node x.js' }) },
      ],
    ],
    [
      'a GNU long link name on a link',
      [longName('K', 'x'.repeat(120)), { path: 'package/l', type: '2' }, hidden],
    ],
    [
      'a PAX size the same as the header',
      [
        paxHeader([
          ['path', 'package/package.json'],
          ['size', String(pkg({ postinstall: 'node x.js' }).length)],
        ]),
        { path: 'package/x', body: pkg({ postinstall: 'node x.js' }) },
      ],
    ],
    ['an empty prefix with its 131st byte set', [{ ...hidden, prefix: `${'\0'.repeat(130)}x` }]],
    [
      'a PAX header over 1 MiB',
      [
        paxHeader([
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
        paxPath('package/package.json'),
        paxHeader([['comment', 'x']]),
        { path: 'package/README', body: pkg({ postinstall: 'node x.js' }) },
      ],
    ],
    [
      'a PAX length with a leading zero',
      [
        { path: 'PaxHeader', type: 'x', body: '030 path=package/package.json\n' },
        { path: 'package/README', body: pkg({ postinstall: 'node x.js' }) },
      ],
    ],
    [
      'a path with an empty part',
      [benign, { path: 'package//package.json', body: pkg({ postinstall: 'node x.js' }) }],
    ],
    [
      'a PAX record with a line break in its value',
      [
        {
          path: 'PaxHeader',
          type: 'x',
          body: (() => {
            const rest = 'x\n29 path=package/package.json\n';
            const record = (len: number) => `${len} comment=${rest}`;
            let len = record(0).length;
            while (record(len).length !== len) len = record(len).length;
            return record(len);
          })(),
        },
        { path: 'package/README', body: pkg({ postinstall: 'node x.js' }) },
      ],
    ],
  ] as [string, (TarEntry | Buffer)[]][])('%s', async (label, entries) => {
    await expectAgreement(tarball(entries), label);
  });

  // Seeded, so that a failure can be replayed.
  it('agrees on tarballs with random damage', async () => {
    let seed = 20261103;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number) => Math.floor(random() * n);
    const bases = [
      [benign, { path: 'package/index.js', body: 'module.exports = 1' }],
      [{ path: 'package/', type: '5' }, hidden, { path: 'package/binding.gyp', body: '{}' }],
      [paxPath(`package/${'d'.repeat(120)}/package.json`), hidden, benign],
      [benign, { path: 'package/lib/', type: '5' }, { path: 'package/lib/a.js', body: 'x' }],
    ]
      .map((entries) => tarball(entries as TarEntry[], { gzip: false }))
      .concat(PACKERS.map((tool) => gunzipSync(packed(tool))));
    for (let n = 0; n < 2000; n++) {
      const tar = Buffer.from(bases[int(bases.length)]!);
      const blocks = tar.length / 512;
      const kind = int(6);
      let damaged: Buffer;
      if (kind === 0) {
        // A byte anywhere, most often in a header's fields.
        const block = int(blocks) * 512;
        tar[block + (random() < 0.8 ? int(345) : int(512))] = int(256);
        // Half the time with the checksum made right again, so node-tar reads the header.
        if (random() < 0.5) {
          tar.fill(0x20, block + 148, block + 156);
          const sum = tar.subarray(block, block + 512).reduce((n, b) => n + b, 0);
          tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, block + 148, 'latin1');
        }
        damaged = tar;
      } else if (kind === 1) {
        // A zero block put in.
        const at = int(blocks) * 512;
        damaged = Buffer.concat([tar.subarray(0, at), Buffer.alloc(512), tar.subarray(at)]);
      } else if (kind === 2) {
        // A block repeated.
        const at = int(blocks) * 512;
        damaged = Buffer.concat([tar.subarray(0, at + 512), tar.subarray(at)]);
      } else if (kind === 3) {
        // Cut at a block.
        damaged = tar.subarray(0, int(blocks) * 512);
      } else {
        // The gzip itself: a second one after it, or bytes after it.
        const other = bases[int(bases.length)]!;
        const tail = kind === 4 ? gzipSync(other) : Buffer.from([int(256), int(256), int(256)]);
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
function packed(name: string): Buffer {
  return readFileSync(new URL(`fixtures/packers/${name}.tgz`, import.meta.url));
}

describe('tarballFetcher: what packers write', () => {
  it.each(PACKERS)('reads what %s packs, as node-tar 6 and 7 read it', async (tool) => {
    const tgz = packed(tool);
    const s = served(tgz);
    const ours = await tarballFetcher(s.fetchImpl, noWait)(s.manifest, 'pkg@1.0.0');
    expect(ours).toEqual({ scripts: { postinstall: 'node x.js' }, bindingGyp: true });
    for (const [version, tar] of NODE_TARS) {
      expect(await npmReads(tgz, tar), `node-tar ${version}`).toEqual(ours);
    }
  });

  // yarn puts the link name on the PAX header too, which node-tar 6 skips and
  // node-tar 7 reads.
  it('does not read a link whose PAX header has a link name, as yarn writes a long one', async () => {
    const s = served(packed('yarn-long-link'));
    expect(await tarballFetcher(s.fetchImpl, noWait)(s.manifest, 'pkg@1.0.0')).toEqual({
      notChecked: expect.stringMatching(/link name on a meta header/) as string,
    });
  });
});
