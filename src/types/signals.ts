/** The signals, their groups, and what computing them takes. */

/** Which side of the verdict table a signal belongs to (see DESIGN.md). */
export type SignalGroup = 'origin' | 'timing' | 'content' | 'tamper' | 'unchecked';

/** Every signal, in the order of DESIGN.md's table, with its group: the only place a group is set. */
export const SIGNALS = {
  'publisher-changed': 'origin',
  'provenance-lost': 'origin',
  'fresh-publish': 'timing',
  'install-scripts': 'content',
  'not-from-registry': 'origin',
  'source-changed': 'tamper',
  'integrity-mismatch': 'tamper',
  'tarball-mismatch': 'tamper',
  'not-in-registry': 'tamper',
  'hidden-code': 'content',
  'new-capability': 'content',
  'content-not-checked': 'content',
  'previous-not-checked': 'unchecked',
} as const satisfies Record<string, SignalGroup>;

export type SignalId = keyof typeof SIGNALS;

/**
 * Every signal has the same shape: what the recent versions looked like
 * (`before`) and what the new version looks like (`after`).
 */
export type Signal = {
  // Each id with its own group, so no signal can carry another group.
  [K in SignalId]: { id: K; group: (typeof SIGNALS)[K]; before: string; after: string };
}[SignalId];

export interface SignalOptions {
  /** The moment the update is being vetted. */
  now: Date;
  /** How many earlier versions count as "the usual" publishers. */
  baselineSize?: number;
  /** A version younger than this is a fresh publish. */
  freshHours?: number;
}
