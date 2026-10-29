import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { kindsIn, LIMITS, readTarball, registryContent, type ReadContent } from '../src/content.js';
import type { Change, VersionManifest } from '../src/types.js';
import { vetChanges } from '../src/vet.js';
import { fakeContent, fakeRegistry, packument } from './helpers.js';

/** One tar entry: a ustar header with its checksum, then the body padded to 512 bytes. */
function entry(name: string, body: string | Buffer = '', type = '0', size?: number): Buffer {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write(`${(size ?? data.length).toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.fill(' ', 148, 156);
  const sum = header.reduce((s, b) => s + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
/** PAX records, each prefixed with its own length, which counts the prefix too. */
const pax = (records: Record<string, string>) =>
  Object.entries(records)
    .map(([k, v]) => {
      const rest = ` ${k}=${v}\n`;
      let n = rest.length;
      while (String(n).length + rest.length !== n) n = String(n).length + rest.length;
      return `${n}${rest}`;
    })
    .join('');
const tar = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);
const tgz = (...entries: Buffer[]) => gzipSync(tar(...entries));
const paths = (files: [string, Buffer][]) => files.map(([p]) => p);

describe('kindsIn', () => {
  it.each([
    ['obfuscated-names', 'const _0x1a2b3c = [];'],
    ['hex-escapes', `'${'\\x61'.repeat(16)}'`],
    ['long-base64', `'${'QUJD'.repeat(250)}'`],
    ['hidden-after-whitespace', `module.exports = 1;${' '.repeat(200)}fetch(u)`],
    ['hidden-after-whitespace', `${' '.repeat(200)}fetch(u)`],
    ['eval', 'eval(atob(s))'],
    ['node-network', "const https = require('node:https');"],
    ['node-network', "import net from 'net';"],
  ])('finds %s', (kind, text) => {
    expect([...kindsIn([['index.js', Buffer.from(text)]]).keys()]).toEqual([kind]);
  });

  // Each of these is in benign code that eval:content measured.
  it.each([
    ['a method named eval', 'parser.eval(x)'],
    ['an identifier ending in eval', 'safeEval(x)'],
    ['15 escapes', `'${'\\x61'.repeat(15)}'`],
    ['999 base64 characters', `'${'A'.repeat(999)}'`],
    ['spaces at the end of a line', `x;${' '.repeat(300)}\ny;`],
    ['a word starting with _0x but too short', '_0x12'],
    ['fetch, which benign updates add', 'await fetch(url)'],
  ])('ignores %s', (_, text) => {
    expect(kindsIn([['index.js', Buffer.from(text)]]).size).toBe(0);
  });

  it('reads every file, whatever its extension or content', () => {
    const found = kindsIn([
      ['README.md', Buffer.from('nothing here')],
      ['lib/data.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(' eval(x)')])],
    ]);
    expect(Object.fromEntries(found)).toEqual({ eval: 'lib/data.bin' });
  });

  it('keeps the first file each kind is found in', () => {
    const found = kindsIn([
      ['a.js', Buffer.from('eval(1)')],
      ['b.js', Buffer.from('eval(2)')],
    ]);
    expect(found.get('eval')).toBe('a.js');
  });
});

describe('readTarball', () => {
  it('reads files gzipped or not, without the first path segment, leaving out links', () => {
    const t = [
      entry('package/', '', '5'),
      entry('package/index.js', 'x'),
      entry('package/link.js', '', '2'),
      entry('package/hard.js', '', '1'),
      entry('package/lib/a.js', 'y', '\0'),
    ];
    expect(paths(readTarball(tgz(...t)))).toEqual(['index.js', 'lib/a.js']);
    expect(paths(readTarball(tar(...t)))).toEqual(['index.js', 'lib/a.js']);
  });

  it('reads an archive without the end marker', () => {
    expect(paths(readTarball(gzipSync(entry('package/a.js', 'x'))))).toEqual(['a.js']);
  });

  it('takes long names from GNU and PAX headers', () => {
    const long = `package/${'d/'.repeat(60)}index.js`;
    const files = readTarball(
      tgz(
        entry('././@LongLink', long, 'L'),
        entry('package/short1', 'a'),
        entry('PaxHeader', pax({ path: long, mtime: '1' }), 'x'),
        entry('package/short2', 'b'),
      ),
    );
    expect(paths(files)).toEqual([long.slice(8), long.slice(8)]);
  });

  it.each([
    ['a PAX size', () => tgz(entry('PaxHeader', pax({ size: '1' }), 'x'), entry('package/a', 'x'))],
    ['a sparse file', () => tgz(entry('package/a.js', 'x', 'S'))],
    ['an archive cut inside a header', () => gzipSync(entry('package/a.js', 'x').subarray(0, 600))],
    ['an entry cut short', () => gzipSync(entry('package/a.js', 'x', '0', 2000))],
    ['something that is not gzip', () => Buffer.from([0x1f, 0x8b, 1, 2, 3])],
  ])('does not read %s', (_, make) => {
    expect(() => readTarball(make())).toThrow();
  });

  it('does not read a header whose checksum is wrong', () => {
    const t = tar(entry('package/a.js', 'x'));
    t[0] = 'q'.charCodeAt(0);
    expect(() => readTarball(t)).toThrow(/bad header/);
  });

  it('stops at each limit', () => {
    const limits = { ...LIMITS, unpackedBytes: 10_000, files: 2, fileBytes: 100 };
    expect(() => readTarball(tgz(entry('package/a', 'x'.repeat(20_000))), limits)).toThrow(
      /over 0.01 MB unpacked/,
    );
    expect(() => readTarball(tgz(entry('package/a', 'x'.repeat(101))), limits)).toThrow(
      /a file over/,
    );
    const three = [entry('package/a', 'x'), entry('package/b', 'x'), entry('package/c', 'x')];
    expect(() => readTarball(tgz(...three), limits)).toThrow(/over 2 files/);
  });
});

describe('registryContent', () => {
  const file = tgz(entry('package/index.js', 'eval(x)'));
  const sha512 = `sha512-${createHash('sha512').update(file).digest('base64')}`;
  const sha1 = createHash('sha1').update(file).digest('hex');
  const manifest = (dist: VersionManifest['dist']): VersionManifest => ({
    version: '1.0.0',
    dist: { tarball: 'https://r/a.tgz', ...dist },
  });
  const serving = (body: Buffer) => {
    const calls: string[] = [];
    const fetchImpl = (url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(new Uint8Array(body)));
    };
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  };

  it('reads a tarball that matches the registry, once per run', async () => {
    const { calls, fetchImpl } = serving(file);
    const read = registryContent(fetchImpl);
    for (const dist of [{ integrity: sha512 }, { integrity: sha512 }]) {
      const content = await read(manifest(dist));
      expect(content).toEqual({ found: new Map([['eval', 'index.js']]) });
    }
    expect(calls).toHaveLength(1);
  });

  it('checks a version from before sha512 against its sha1', async () => {
    const content = await registryContent(serving(file).fetchImpl)(manifest({ shasum: sha1 }));
    expect('found' in content).toBe(true);
  });

  it('fails the run when the tarball does not match the registry', async () => {
    const other = `sha512-${createHash('sha512').update('other').digest('base64')}`;
    await expect(
      registryContent(serving(file).fetchImpl)(manifest({ integrity: other })),
    ).rejects.toThrow(/does not match the registry's hash/);
  });

  it('fails the run when the registry cannot be reached', async () => {
    const down = () => Promise.reject(new TypeError('fetch failed'));
    await expect(
      registryContent(down as unknown as typeof fetch)(manifest({ integrity: sha512 })),
    ).rejects.toThrow(/fetching the tarball of 1.0.0 .* failed/);
  });

  it('does not download a release the registry declares over a limit', async () => {
    const { calls, fetchImpl } = serving(file);
    const read = registryContent(fetchImpl);
    expect(await read(manifest({ integrity: sha512, unpackedSize: 600_000_000 }))).toEqual({
      unread: 'over 512 MB unpacked',
    });
    const many = { tarball: 'https://r/b.tgz', integrity: sha512, fileCount: 100_001 };
    expect(await read(manifest(many))).toEqual({
      unread: 'over 100000 files',
    });
    expect(calls).toHaveLength(0);
  });

  it('stops a download over the limit', async () => {
    const read = registryContent(serving(file).fetchImpl, { ...LIMITS, downloadBytes: 10 });
    expect(await read(manifest({ integrity: sha512 }))).toEqual({
      unread: 'over 0.00001 MB to download',
    });
  });

  it('does not read a release without a hash to check', async () => {
    expect(await registryContent(serving(file).fetchImpl)(manifest({}))).toEqual({
      unread: 'no sha512 or sha1 hash in the registry',
    });
  });
  it('reads at most `concurrency` tarballs at a time', async () => {
    let open = 0;
    let most = 0;
    const slow = async () => {
      most = Math.max(most, ++open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      return new Response(new Uint8Array(tgz(entry('package/a', 'x'))));
    };
    const read = registryContent(slow, LIMITS, 2);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        read({
          version: '1.0.0',
          dist: { tarball: `https://r/${i}.tgz`, shasum: '0'.repeat(40) },
        }).catch(() => undefined),
      ),
    );
    expect(most).toBe(2);
  });
});

// Through vetChanges, which decides what is read and in what order.
describe('content signals', () => {
  const now = new Date('2026-01-10T00:00:00Z');
  const registry = fakeRegistry(
    packument('pkg', [
      { version: '1.0.0', time: '2025-01-01T00:00:00Z' },
      { version: '1.1.0', time: '2025-06-01T00:00:00Z' },
      { version: '1.2.0', time: '2025-12-01T00:00:00Z' },
    ]),
    packument('new', [{ version: '1.0.0', time: '2025-01-01T00:00:00Z' }]),
  );
  const change: Change = { name: 'pkg', from: '1.1.0', to: '1.2.0' };
  const vet = async (c: Change, read: ReadContent) =>
    (await vetChanges([c], registry, read, { now }))[0]!.signals;
  const obfuscated = 'var _0xabcd=1;';

  it('flags kinds the new version has and the version replaced has in none of its files', async () => {
    const read = fakeContent({
      'pkg@1.1.0': { 'index.js': 'eval(x)' },
      'pkg@1.2.0': { 'index.js': 'eval(x)', 'lib/x.js': `${obfuscated} require('https')` },
    });
    expect(await vet(change, read)).toEqual([
      {
        id: 'hidden-code',
        group: 'content',
        before: 'none in 1.1.0',
        after: 'obfuscated-names in lib/x.js',
      },
      {
        id: 'new-capability',
        group: 'content',
        before: 'none in 1.1.0',
        after: 'node-network in lib/x.js',
      },
    ]);
  });

  it('compares a new package with the version before it, as install-scripts does', async () => {
    const read = fakeContent({
      'pkg@1.1.0': { 'a.js': obfuscated },
      'pkg@1.2.0': { 'a.js': obfuscated },
    });
    expect(await vet({ ...change, from: null }, read)).toEqual([]);
  });

  it('flags every kind in a first release', async () => {
    const read = fakeContent({ 'new@1.0.0': { 'a.js': 'eval(x)' } });
    const [s] = await vet({ name: 'new', from: null, to: '1.0.0' }, read);
    expect(s).toMatchObject({ id: 'new-capability', before: 'no earlier version' });
  });

  it('reads the version replaced only when the new one has a kind to compare', async () => {
    const asked: string[] = [];
    const read = fakeContent();
    const counting = (m: VersionManifest) => (asked.push(m.version), read(m));
    expect(await vet(change, counting)).toEqual([]);
    expect(asked).toEqual(['1.2.0']);
  });

  it('makes a new version it could not read a content change', async () => {
    const read = fakeContent({ 'pkg@1.2.0': 'over 512 MB unpacked' });
    expect(await vet(change, read)).toEqual([
      {
        id: 'content-not-checked',
        group: 'content',
        before: 'files read',
        after: 'over 512 MB unpacked',
      },
    ]);
  });

  it('says when the version replaced could not be read', async () => {
    const read = fakeContent({
      'pkg@1.2.0': { 'a.js': 'eval(x)' },
      'pkg@1.1.0': 'tar: bad header',
    });
    expect(await vet(change, read)).toEqual([
      {
        id: 'previous-not-checked',
        group: 'unchecked',
        before: '1.1.0: tar: bad header',
        after: 'not compared',
      },
    ]);
  });

  it('reads nothing for a version not from the registry', async () => {
    const read = () => Promise.reject(new Error('read'));
    const [s] = await vet({ ...change, source: 'git+https://x' }, read);
    expect(s?.id).toBe('source-changed');
  });
});
