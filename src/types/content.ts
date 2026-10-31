/** What reading a release's files gives. */

import type { VersionManifest } from './registry.js';

/**
 * Each kind found in a release, with the first file it was found in; or why
 * the files were not read.
 */
export type Content = { found: Map<string, string> } | { unread: string };

/** Reads a version's files. Throws only when the registry cannot be reached. */
export type ReadContent = (version: VersionManifest, signal?: AbortSignal) => Promise<Content>;
