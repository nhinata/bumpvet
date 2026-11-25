import type { Signal } from './types/signals.js';
import type { Verdict } from './types/verdicts.js';

/**
 * The verdict table of DESIGN.md. Timing alone does not count: almost every
 * update is fresh when vetted soon after publish (see eval/README.md).
 */
export function decideVerdict(signals: Signal[]): Verdict {
  const hasGroup = (group: Signal['group']) => signals.some((s) => s.group === group);
  if (hasGroup('tamper')) return 'block';
  if (hasGroup('content') && (hasGroup('origin') || hasGroup('timing'))) return 'block';
  if (hasGroup('origin') || hasGroup('content')) return 'review';
  return 'ok';
}
