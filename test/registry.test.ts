import { describe, expect, it } from 'vitest';
import { registryFetcher, slim } from '../src/registry.js';

const raw = {
  name: 'pkg',
  readme: 'x'.repeat(1000),
  time: { '1.0.0': '2025-01-01T00:00:00Z' },
  versions: {
    '1.0.0': {
      version: '1.0.0',
      description: 'dropped',
      _npmUser: { name: 'alice', email: 'a@example.com' },
      scripts: { test: 'vitest', postinstall: 'node x.js' },
      dist: {
        integrity: 'sha512-x',
        tarball: 'https://…',
        attestations: { url: 'https://…', provenance: {} },
      },
    },
  },
};

describe('slim', () => {
  it('keeps what the signals read and drops the rest', () => {
    expect(slim(raw, 'pkg')).toEqual({
      name: 'pkg',
      time: { '1.0.0': '2025-01-01T00:00:00Z' },
      versions: {
        '1.0.0': {
          version: '1.0.0',
          _npmUser: { name: 'alice' },
          scripts: { postinstall: 'node x.js' },
          dist: { integrity: 'sha512-x', attestations: true },
        },
      },
    });
  });

  it('tolerates missing fields, using the requested name', () => {
    expect(slim({}, 'pkg')).toEqual({ name: 'pkg', time: {}, versions: {} });
    expect(slim(null, 'pkg')).toEqual({ name: 'pkg', time: {}, versions: {} });
    expect(slim({ versions: { '1.0.0': {} } }, 'pkg').versions['1.0.0']).toEqual({
      version: '1.0.0',
      _npmUser: undefined,
      scripts: undefined,
      dist: { integrity: undefined, attestations: undefined },
    });
  });

  it('reads an unpublished package, whose `time` holds an object', () => {
    const unpublished = {
      name: 'gone',
      time: {
        created: '2020-01-01T00:00:00Z',
        modified: '2021-01-01T00:00:00Z',
        unpublished: { time: '2021-01-01T00:00:00Z', versions: ['1.0.0'] },
      },
    };
    expect(slim(unpublished, 'gone')).toEqual({
      name: 'gone',
      time: { created: '2020-01-01T00:00:00Z', modified: '2021-01-01T00:00:00Z' },
      versions: {},
    });
  });

  it('drops fields of the wrong type', () => {
    const odd = {
      name: 42,
      time: { '1.0.0': 7 },
      versions: {
        '1.0.0': null,
        '1.1.0': {
          _npmUser: 'alice',
          scripts: { postinstall: { run: 'x' }, install: 3, preinstall: 'node p.js' },
          dist: { integrity: ['sha512-x'] },
        },
      },
    };
    expect(slim(odd, 'pkg')).toEqual({
      name: 'pkg',
      time: {},
      versions: {
        '1.1.0': {
          version: '1.1.0',
          _npmUser: undefined,
          scripts: { preinstall: 'node p.js' },
          dist: { integrity: undefined, attestations: undefined },
        },
      },
    });
  });
});

describe('registryFetcher', () => {
  const respond = (status: number, body?: unknown) => () =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));

  it('encodes scoped names and caches by name', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return respond(200, raw)();
    }) as unknown as typeof fetch;
    const get = registryFetcher('https://r/', fetchImpl);
    await get('@scope/pkg');
    await get('@scope/pkg');
    expect(urls).toEqual(['https://r/@scope%2fpkg']);
  });

  it('returns null for a package the registry does not have', async () => {
    expect(
      await registryFetcher('https://r/', respond(404) as unknown as typeof fetch)('nope'),
    ).toBeNull();
  });

  it('fails on other errors', async () => {
    await expect(
      registryFetcher('https://r/', respond(503) as unknown as typeof fetch)('pkg'),
    ).rejects.toThrow(/503/);
  });
});
