/** The verdicts and a package's result. */

import type { Signal } from './signals.js';

/** Every verdict, the most severe first: the order reports list them in. */
export const VERDICTS = ['block', 'review', 'ok'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface PackageResult {
  name: string;
  from: string | null;
  to: string;
  verdict: Verdict;
  signals: Signal[];
}
