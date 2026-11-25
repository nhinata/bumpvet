import { describe, expect, it } from 'vitest';
import { createPackumentFetcher, parsePackument } from '../src/registry.js';
import { REGISTRY } from '../src/types/registry.js';

const RAW = {
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

describe('parsePackument', () => {
  it('keeps what the signals read and drops the rest', () => {
    expect(parsePackument(RAW, 'pkg')).toEqual({
      name: 'pkg',
      time: { '1.0.0': '2025-01-01T00:00:00Z' },
      versions: {
        '1.0.0': {
          version: '1.0.0',
          _npmUser: { name: 'alice' },
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
    const parseShasum = (v: unknown) =>
      parsePackument({ versions: { '1.0.0': { dist: { shasum: v } } } }, 'pkg').versions['1.0.0']!
        .dist!.shasum;
    expect(parseShasum('AB8ECE0C4062DA5F6D2FA1D07FC4CDB5F8B9B25B')).toBe(
      'ab8ece0c4062da5f6d2fa1d07fc4cdb5f8b9b25b',
    );
    expect(parseShasum('ab8ece0c')).toBeUndefined();
    expect(parseShasum('zz'.repeat(20))).toBeUndefined();
    expect(parseShasum(42)).toBeUndefined();
  });

  it('tolerates missing fields, using the requested name', () => {
    expect(parsePackument({ name: '', versions: {} }, 'pkg')).toEqual({
      name: 'pkg',
      time: {},
      versions: {},
    });
    expect(parsePackument({ versions: { '1.0.0': {} } }, 'pkg').versions['1.0.0']).toEqual({
      version: '1.0.0',
      _npmUser: undefined,
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
      expect(() => parsePackument(raw, 'pkg')).toThrow(
        'registry sent something that is not a packument for pkg',
      );
    },
  );

  it('keeps a `__proto__` key as an ordinary key', () => {
    const p = parsePackument(
      JSON.parse('{"versions": {"__proto__": {"_npmUser": {"name": "x"}}}}'),
      'pkg',
    );
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
    expect(parsePackument(unpublished, 'gone')).toEqual({
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
          dist: { integrity: ['sha512-x'] },
        },
      },
    };
    expect(parsePackument(odd, 'pkg')).toEqual({
      name: 'pkg',
      time: {},
      versions: {
        '1.1.0': {
          version: '1.1.0',
          _npmUser: undefined,
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

describe('createPackumentFetcher', () => {
  const createResponder =
    (status: number, body?: unknown, headers?: Record<string, string>) => () =>
      Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
      );
  /** Records each wait instead of waiting. */
  const createWaitRecorder = () => {
    const ms: number[] = [];
    const waitDelay = (n: number) => {
      ms.push(n);
      return Promise.resolve();
    };
    return { ms, waitDelay };
  };
  /** Gives each response in turn, the last one for every later request. */
  const createSequentialServer = (...responses: (() => Promise<Response>)[]) => {
    let calls = 0;
    const fetchImpl = (() =>
      responses[Math.min(calls++, responses.length - 1)]!()) as unknown as typeof fetch;
    return { fetchImpl, countCalls: () => calls };
  };
  const createFailingResponder = (cause: unknown) => () =>
    Promise.reject(new TypeError('fetch failed', { cause }));

  it('encodes scoped names and caches by name', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return createResponder(200, RAW)();
    }) as unknown as typeof fetch;
    const fetchPackument = createPackumentFetcher(fetchImpl);
    await fetchPackument('@scope/pkg');
    await fetchPackument('@scope/pkg');
    expect(urls).toEqual([`${REGISTRY}@scope%2fpkg`]);
  });

  it('returns null for a package the registry does not have, without retrying', async () => {
    const r = createSequentialServer(createResponder(404));
    expect(
      await createPackumentFetcher(r.fetchImpl, createWaitRecorder().waitDelay)('nope'),
    ).toBeNull();
    expect(r.countCalls()).toBe(1);
  });

  it('names the package when the body is not JSON, without retrying', async () => {
    const r = createSequentialServer(() =>
      Promise.resolve(new Response('<!DOCTYPE html>', { status: 200 })),
    );
    await expect(
      createPackumentFetcher(r.fetchImpl, createWaitRecorder().waitDelay)('pkg'),
    ).rejects.toThrow('registry sent invalid JSON for pkg');
    expect(r.countCalls()).toBe(1);
  });

  it('fails on other client errors without retrying', async () => {
    const r = createSequentialServer(createResponder(400));
    await expect(
      createPackumentFetcher(r.fetchImpl, createWaitRecorder().waitDelay)('pkg'),
    ).rejects.toThrow(/^registry returned 400 for pkg$/);
    expect(r.countCalls()).toBe(1);
  });

  // npm's waits (fetch-retries 2, mintimeout 10 s, factor 10, maxtimeout 60 s).
  it('retries a server error after 10 and 60 seconds, then says how often it tried', async () => {
    const r = createSequentialServer(createResponder(503));
    const w = createWaitRecorder();
    await expect(createPackumentFetcher(r.fetchImpl, w.waitDelay)('pkg')).rejects.toThrow(
      'registry returned 503 for pkg; gave up after 3 attempts',
    );
    expect(r.countCalls()).toBe(3);
    expect(w.ms).toEqual([10_000, 60_000]);
  });

  it('returns the packument when a retry succeeds', async () => {
    const r = createSequentialServer(createResponder(429), createResponder(200, RAW));
    const p = await createPackumentFetcher(r.fetchImpl, createWaitRecorder().waitDelay)('pkg');
    expect(p?.versions['1.0.0']?._npmUser).toEqual({ name: 'alice' });
  });

  it('waits as long as Retry-After asks, in seconds or as a date, up to 60 seconds', async () => {
    const r = createSequentialServer(
      createResponder(429, undefined, { 'retry-after': '30' }),
      createResponder(503, undefined, { 'retry-after': '90' }),
      createResponder(200, RAW),
    );
    const w = createWaitRecorder();
    await createPackumentFetcher(r.fetchImpl, w.waitDelay)('pkg');
    expect(w.ms).toEqual([30_000, 60_000]);
    // A date 30 seconds ahead; HTTP dates have whole seconds.
    const soon = new Date(Date.now() + 30_000).toUTCString();
    const d = createSequentialServer(
      createResponder(503, undefined, { 'retry-after': soon }),
      createResponder(200, RAW),
    );
    const dw = createWaitRecorder();
    await createPackumentFetcher(d.fetchImpl, dw.waitDelay)('pkg');
    expect(dw.ms[0]).toBeGreaterThan(28_000);
    expect(dw.ms[0]).toBeLessThanOrEqual(30_000);
  });

  it('retries when the request itself fails, and names the package and the reason', async () => {
    const r = createSequentialServer(createFailingResponder(new Error('getaddrinfo ENOTFOUND r')));
    await expect(
      createPackumentFetcher(r.fetchImpl, createWaitRecorder().waitDelay)('pkg'),
    ).rejects.toThrow(
      'fetching pkg from the registry failed: fetch failed (getaddrinfo ENOTFOUND r); gave up after 3 attempts',
    );
    expect(r.countCalls()).toBe(3);
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
    const r = createSequentialServer(createFailingResponder(refused));
    await expect(
      createPackumentFetcher(r.fetchImpl, createWaitRecorder().waitDelay)('pkg'),
    ).rejects.toThrow(
      'fetching pkg from the registry failed: fetch failed (connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443)',
    );
  });

  // Not "invalid JSON": the body never arrived.
  it('retries when the connection closes while the body is read', async () => {
    const respondClosing = () => {
      const body = new ReadableStream({
        pull(controller) {
          controller.error(new TypeError('terminated', { cause: new Error('other side closed') }));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const r = createSequentialServer(respondClosing, createResponder(200, RAW));
    expect(
      await createPackumentFetcher(r.fetchImpl, createWaitRecorder().waitDelay)('pkg'),
    ).not.toBeNull();
    const failing = createSequentialServer(respondClosing);
    await expect(
      createPackumentFetcher(failing.fetchImpl, createWaitRecorder().waitDelay)('pkg'),
    ).rejects.toThrow(
      'reading the registry response for pkg failed: terminated (other side closed)',
    );
  });

  it('does not retry a request the signal stopped', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls++;
      return Promise.reject(new Error('aborted'));
    }) as unknown as typeof fetch;
    const w = createWaitRecorder();
    const stop = new AbortController();
    stop.abort();
    await expect(
      createPackumentFetcher(fetchImpl, w.waitDelay)('pkg', stop.signal),
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
    expect(w.ms).toEqual([]);
  });

  it('stops waiting for a retry when the signal is aborted', async () => {
    const r = createSequentialServer(createResponder(503));
    const stop = new AbortController();
    const fetchPackument = createPackumentFetcher(r.fetchImpl);
    const p = fetchPackument('pkg', stop.signal);
    // Let the first request fail and the 10-second wait start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop.abort();
    await expect(p).rejects.toThrow(/abort/i);
    expect(r.countCalls()).toBe(1);
  });
});
