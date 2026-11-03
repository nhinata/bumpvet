/** What bumpvet reads from a tarball. */

import type { VersionManifest } from './registry.js';

/** The scripts npm runs when it installs a package. */
export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;
export type InstallHook = (typeof INSTALL_HOOKS)[number];

/**
 * The subset of a tarball that bumpvet reads: what npm can run from it when
 * it installs it (DESIGN.md, threat model).
 */
export interface Tarball {
  /** The install hooks of the root package.json; none without one. */
  scripts: Partial<Record<InstallHook, string>>;
  /** Whether there is a binding.gyp at the root. */
  bindingGyp: boolean;
}

/** Why a tarball was not read. */
export interface NotChecked {
  notChecked: string;
}

/** Reads the tarball `manifest` names; `what` names the version in errors. */
export type FetchTarball = (
  manifest: VersionManifest,
  what: string,
  signal?: AbortSignal,
) => Promise<Tarball | NotChecked>;
