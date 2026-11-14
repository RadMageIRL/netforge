/**
 * DST changes ahead: which transitions in a zone touch a schedule, so a daily 02:30 job learns
 * about the spring-forward night even when it is months away from the next ten runs.
 */
import type { Transition } from './zone-timeline';
import { findTransition, offsetAt } from '../time/zones';

const HALF_DAY = 43_200_000;

/**
 * Offset changes in [fromMs, toMs). Offsets are sampled every 12 hours and each change is located
 * by bisection; no zone changes its offset twice within 12 hours.
 */
export function zoneTransitions(zone: string, fromMs: number, toMs: number): Transition[] {
  const out: Transition[] = [];
  let t = fromMs;
  let prev = offsetAt(t, zone);
  while (t < toMs) {
    const next = Math.min(t + HALF_DAY, toMs);
    const cur = offsetAt(next, zone);
    if (cur !== prev) {
      const at = findTransition(t, next, zone);
      out.push({ at, before: prev, after: cur });
      prev = cur;
    }
    t = next;
  }
  return out;
}

export interface DstImpact {
  readonly transition: Transition;
  /** Scheduled local times that do not exist, or that happen twice. */
  readonly kind: 'nonexistent' | 'repeated';
  readonly firstWallMs: number;
  readonly lastWallMs: number;
  readonly count: number;
}

export const DST_LOOKAHEAD_MS = 366 * 86_400_000;
const MAX_WALLS_PER_TRANSITION = 10_000;

/**
 * For each transition in the next year, the scheduled wall times it skips or repeats. `walls`
 * yields a schedule's wall times (as UTC milliseconds) from a given wall time onward, in order.
 */
export function dstImpacts(walls: (startWallMs: number) => Iterator<number>, zone: string, fromMs: number, lookaheadMs = DST_LOOKAHEAD_MS): DstImpact[] {
  const out: DstImpact[] = [];
  for (const tr of zoneTransitions(zone, fromMs, fromMs + lookaheadMs)) {
    const gap = tr.after > tr.before;
    const lo = tr.at + Math.min(tr.before, tr.after);
    const hi = tr.at + Math.max(tr.before, tr.after);
    const it = walls(lo);
    let first = -1;
    let last = -1;
    let count = 0;
    for (let i = 0; i < MAX_WALLS_PER_TRANSITION; i++) {
      const n = it.next();
      if (n.done || n.value >= hi) break;
      if (first < 0) first = n.value;
      last = n.value;
      count++;
    }
    if (count > 0) out.push({ transition: tr, kind: gap ? 'nonexistent' : 'repeated', firstWallMs: first, lastWallMs: last, count });
  }
  return out;
}
