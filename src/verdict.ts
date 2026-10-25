import type { Signal, Verdict } from './types.js';

/**
 * The verdict table of DESIGN.md. Timing alone does not count: almost every
 * update is fresh when a bot opens the pull request (see eval/README.md).
 */
export function decide(signals: Signal[]): Verdict {
  const has = (group: Signal['group']) => signals.some((s) => s.group === group);
  if (has('tamper')) return 'block';
  if (has('content') && (has('origin') || has('timing'))) return 'block';
  if (has('origin') || has('content')) return 'review';
  return 'ok';
}
