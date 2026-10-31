import { describe, expect, it } from 'vitest';
import { registryFetcher, slim } from '../src/registry.js';
import { REGISTRY } from '../src/types/registry.js';

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
          dist: {
            integrity: 'sha512-x',
            shasum: undefined,
            tarball: 'https://…',
            attestations: true,
          },
        },
      },
    });
  });

  it('keeps a shasum only when it is a sha1, in lowercase', () => {
    const shasum = (v: unknown) =>
      slim({ versions: { '1.0.0': { dist: { shasum: v } } } }, 'pkg').versions['1.0.0']!.dist!
        .shasum;
    expect(shasum('AB8ECE0C4062DA5F6D2FA1D07FC4CDB5F8B9B25B')).toBe(
      'ab8ece0c4062da5f6d2fa1d07fc4cdb5f8b9b25b',
    );
    expect(shasum('ab8ece0c')).toBeUndefined();
    expect(shasum('zz'.repeat(20))).toBeUndefined();
    expect(shasum(42)).toBeUndefined();
  });

  it('tolerates missing fields, using the requested name', () => {
    expect(slim({ name: '', versions: {} }, 'pkg')).toEqual({
      name: 'pkg',
      time: {},
      versions: {},
    });
    expect(slim({ versions: { '1.0.0': {} } }, 'pkg').versions['1.0.0']).toEqual({
      version: '1.0.0',
      _npmUser: undefined,
      scripts: undefined,
      dist: {
        integrity: undefined,
        shasum: undefined,
        tarball: undefined,
        attestations: undefined,
      },
    });
  });

  it.each([[null], [[]], ['text'], [{ error: 'not found' }]])(
    'rejects a response that is not a packument: %j',
    (raw) => {
      expect(() => slim(raw, 'pkg')).toThrow(
        'registry sent something that is not a packument for pkg',
      );
    },
  );

  it('keeps a `__proto__` key as an ordinary key', () => {
    const p = slim(JSON.parse('{"versions": {"__proto__": {"_npmUser": {"name": "x"}}}}'), 'pkg');
    expect(Object.getPrototypeOf(p.versions)).toBeNull();
    expect(Object.keys(p.versions)).toEqual(['__proto__']);
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
          dist: {
            integrity: undefined,
            shasum: undefined,
            tarball: undefined,
            attestations: undefined,
          },
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
    const get = registryFetcher(fetchImpl);
    await get('@scope/pkg');
    await get('@scope/pkg');
    expect(urls).toEqual([`${REGISTRY}@scope%2fpkg`]);
  });

  it('returns null for a package the registry does not have', async () => {
    expect(await registryFetcher(respond(404) as unknown as typeof fetch)('nope')).toBeNull();
  });

  it('names the package when the body is not JSON', async () => {
    const html = () => Promise.resolve(new Response('<!DOCTYPE html>', { status: 200 }));
    await expect(registryFetcher(html as unknown as typeof fetch)('pkg')).rejects.toThrow(
      'registry sent invalid JSON for pkg',
    );
  });

  it('names the package and the reason when the request itself fails', async () => {
    const down = () =>
      Promise.reject(
        new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND r') }),
      );
    await expect(registryFetcher(down as unknown as typeof fetch)('pkg')).rejects.toThrow(
      'fetching pkg from the registry failed: fetch failed (getaddrinfo ENOTFOUND r)',
    );
  });

  // The shapes Node.js 22 and 24 give (issue #8).
  it('gives the reason when every address of the host refused', async () => {
    const refused = Object.assign(
      new AggregateError(
        [
          new Error('connect ECONNREFUSED ::1:443'),
          new Error('connect ECONNREFUSED 127.0.0.1:443'),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    );
    const down = () => Promise.reject(new TypeError('fetch failed', { cause: refused }));
    await expect(registryFetcher(down as unknown as typeof fetch)('pkg')).rejects.toThrow(
      'fetching pkg from the registry failed: fetch failed (connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443)',
    );
  });

  // Not "invalid JSON": the body never arrived.
  it('gives the reason when the connection closes while the body is read', async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
      },
    });
    const reset = () => Promise.resolve(new Response(body, { status: 200 }));
    await expect(registryFetcher(reset as unknown as typeof fetch)('pkg')).rejects.toThrow(
      'reading the registry response for pkg failed: terminated (other side closed)',
    );
  });

  it('fails on other errors', async () => {
    await expect(registryFetcher(respond(503) as unknown as typeof fetch)('pkg')).rejects.toThrow(
      /503/,
    );
  });
});
