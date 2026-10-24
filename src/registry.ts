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
        return slim((await res.json()) as Packument);
      })();
      cache.set(name, p);
    }
    return p;
  };
}

/**
 * Keeps only the fields bumpvet reads. Full packuments of large packages are
 * tens of megabytes, and every one stays cached for the whole run.
 */
export function slim(p: Packument): Packument {
  const versions: Record<string, VersionManifest> = {};
  for (const [v, m] of Object.entries(p.versions ?? {})) {
    const scripts =
      m.scripts &&
      Object.fromEntries(
        INSTALL_HOOKS.filter((h) => m.scripts![h]).map((h) => [h, m.scripts![h]!]),
      );
    versions[v] = {
      version: v,
      _npmUser: m._npmUser?.name ? { name: m._npmUser.name } : undefined,
      scripts,
      dist: { integrity: m.dist?.integrity, attestations: m.dist?.attestations ? true : undefined },
    };
  }
  return { name: p.name, time: p.time ?? {}, versions };
}
