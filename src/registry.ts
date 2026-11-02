import { setTimeout as delay } from 'node:timers/promises';
import { messageWithCause } from './utils/errors.js';
import { isObject, str } from './utils/json.js';
import {
  INSTALL_HOOKS,
  REGISTRY,
  type FetchPackument,
  type Packument,
  type VersionManifest,
} from './types/registry.js';

/** Where the registry serves a package's packument: a scoped name keeps its `@` and encodes its `/`. */
const packumentUrl = (name: string) => REGISTRY + name.replace('/', '%2f');

/**
 * npm's defaults (`fetch-retries` 2, `fetch-retry-mintimeout` 10 s,
 * `fetch-retry-factor` 10, `fetch-retry-maxtimeout` 60 s), so that bumpvet
 * gives the registry as long as `npm ci` in the same job does. Not measured
 * for bumpvet.
 */
const NPM_RETRY = { retries: 2, minTimeout: 10_000, factor: 10, maxTimeout: 60_000 };
/** The wait before each retry, as npm computes it: 10 s, then 60 s. */
const RETRY_WAITS = Array.from({ length: NPM_RETRY.retries }, (_, i) =>
  Math.min(NPM_RETRY.minTimeout * NPM_RETRY.factor ** i, NPM_RETRY.maxTimeout),
);
/** The statuses npm retries (make-fetch-happen). 404 is an answer: the package is not there. */
const retried = (status: number) => [408, 420, 429].includes(status) || status >= 500;

/** A failure that may pass if the request is made again: a status above, or the network. */
class Transient extends Error {
  constructor(
    message: string,
    options?: { cause?: unknown },
    /** What the registry's `Retry-After` asked for, in milliseconds. */
    readonly retryAfter?: number,
  ) {
    super(message, options);
  }
}

type Wait = (ms: number, signal?: AbortSignal) => Promise<unknown>;
const wait: Wait = (ms, signal) => delay(ms, undefined, { signal });

/**
 * Fetches full packuments from the public registry. Returns null for a package
 * the registry does not have. Network errors and the statuses npm retries are
 * tried again after each of RETRY_WAITS.
 *
 * Each name is fetched once, and later calls share that fetch, whatever signal
 * they pass: give one fetcher one signal, as a run does.
 */
export function registryFetcher(fetchImpl: typeof fetch = fetch, waitImpl = wait): FetchPackument {
  const cache = new Map<string, Promise<Packument | null>>();
  return (name, signal) => {
    let p = cache.get(name);
    if (!p) {
      p = (async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await fetchOnce(fetchImpl, name, signal);
          } catch (err) {
            if (!(err instanceof Transient) || signal?.aborted) throw err;
            const next = RETRY_WAITS[attempt - 1];
            if (next === undefined) {
              throw new Error(`${err.message}; gave up after ${attempt} attempts`, { cause: err });
            }
            await waitImpl(
              Math.min(Math.max(next, err.retryAfter ?? 0), NPM_RETRY.maxTimeout),
              signal,
            );
          }
        }
      })();
      cache.set(name, p);
    }
    return p;
  };
}

async function fetchOnce(
  fetchImpl: typeof fetch,
  name: string,
  signal: AbortSignal | undefined,
): Promise<Packument | null> {
  const timeout = AbortSignal.timeout(60_000);
  let res: Response;
  try {
    res = await fetchImpl(packumentUrl(name), {
      headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    const reason = messageWithCause(err);
    throw new Transient(`fetching ${name} from the registry failed: ${reason}`, { cause: err });
  }
  if (!res.ok) {
    // Unread, the body would hold the connection until garbage collection.
    // A body that already failed rejects the cancel; the status is what matters here.
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) return null;
    const message = `registry returned ${res.status} for ${name}`;
    if (!retried(res.status)) throw new Error(message);
    throw new Transient(message, undefined, retryAfter(res.headers.get('retry-after')));
  }
  // Read first, then parse: a timeout or reset mid-body is not "invalid JSON".
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const reason = messageWithCause(err);
    throw new Transient(`reading the registry response for ${name} failed: ${reason}`, {
      cause: err,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`registry sent invalid JSON for ${name}`, { cause: err });
  }
  return slim(json, name);
}

/** A `Retry-After` value, seconds or an HTTP date, in milliseconds from now. */
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Keeps only the fields bumpvet reads, and only when they have the type bumpvet
 * expects: the response comes from the network and nothing in it is
 * guaranteed. (An unpublished package, for one, has an object in `time`.) Full
 * packuments of large packages are tens of megabytes, and every one stays
 * cached for the whole run.
 */
export function slim(raw: unknown, name: string): Packument {
  // Anything else (null, an array, `{"error": ...}`) is a broken registry, not a package to block.
  if (!isObject(raw) || (!isObject(raw.versions) && !isObject(raw.time))) {
    throw new Error(`registry sent something that is not a packument for ${name}`);
  }
  // No prototype: a `__proto__` key from the registry stays an ordinary key.
  const time = Object.create(null) as Record<string, string>;
  if (isObject(raw.time)) {
    for (const [k, v] of Object.entries(raw.time)) if (typeof v === 'string') time[k] = v;
  }
  const versions = Object.create(null) as Record<string, VersionManifest>;
  if (isObject(raw.versions)) {
    for (const [v, m] of Object.entries(raw.versions)) {
      if (!isObject(m)) continue;
      const user = isObject(m._npmUser) ? str(m._npmUser.name) : undefined;
      const scripts = isObject(m.scripts) ? m.scripts : undefined;
      const dist = isObject(m.dist) ? m.dist : {};
      versions[v] = {
        version: v,
        _npmUser: user ? { name: user } : undefined,
        scripts:
          scripts &&
          Object.fromEntries(
            INSTALL_HOOKS.flatMap((h) => {
              const script = str(scripts[h]);
              return script ? [[h, script]] : [];
            }),
          ),
        dist: {
          integrity: str(dist.integrity),
          shasum: sha1Hex(dist.shasum),
          tarball: str(dist.tarball),
          attestations: dist.attestations ? true : undefined,
          unpackedSize: count(dist.unpackedSize),
          fileCount: count(dist.fileCount),
        },
      };
    }
  }
  return { name: str(raw.name) || name, time, versions };
}

const sha1Hex = (v: unknown) =>
  typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : undefined;

const count = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
