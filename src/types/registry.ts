/** What bumpvet reads from the registry. */

/** The subset of an npm packument that bumpvet reads. */
export interface Packument {
  name: string;
  time: Record<string, string>;
  versions: Record<string, VersionManifest>;
}

export interface VersionManifest {
  version: string;
  _npmUser?: { name?: string };
  scripts?: Record<string, string>;
  dist?: {
    integrity?: string;
    /** The sha1 in lowercase hex; dropped when it is not one. */
    shasum?: string;
    tarball?: string;
    attestations?: unknown;
    /** As the publisher declared them. */
    unpackedSize?: number;
    fileCount?: number;
  };
}

export type FetchPackument = (name: string) => Promise<Packument | null>;

/** The scripts npm runs when it installs a package. */
export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;
