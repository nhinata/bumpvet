import { INSTALL_HOOKS } from './signals.js';
import type { Packument, VersionManifest } from './types.js';

export type FetchPackument = (name: string) => Promise<Packument | null>;

/** Fetches full packuments from the public registry. Returns null for a package the registry does not have. */
export function registryFetcher(
  base = 'https://registry.npmjs.org/',
  fetchImpl: typeof fetch = fetch,
): FetchPackument {
  const cache = new Map<string, Promise<Packument | null>>();
  return (name) => {
    let p = cache.get(name);
    if (!p) {
      p = (async () => {
        const res = await fetchImpl(base + name.replace('/', '%2f'), {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`registry returned ${res.status} for ${name}`);
        let json: unknown;
        try {
          json = await res.json();
        } catch (err) {
          throw new Error(`registry sent invalid JSON for ${name}`, { cause: err });
        }
        return slim(json, name);
      })();
      cache.set(name, p);
    }
    return p;
  };
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

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
  const json = raw;
  // No prototype: a `__proto__` key from the registry stays an ordinary key.
  const time = Object.create(null) as Record<string, string>;
  if (isObject(json.time)) {
    for (const [k, v] of Object.entries(json.time)) if (typeof v === 'string') time[k] = v;
  }
  const versions = Object.create(null) as Record<string, VersionManifest>;
  if (isObject(json.versions)) {
    for (const [v, m] of Object.entries(json.versions)) {
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
          attestations: dist.attestations ? true : undefined,
        },
      };
    }
  }
  return { name: str(json.name) || name, time, versions };
}
