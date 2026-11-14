/**
 * Fast, exact mapping of wall times to instants in one IANA zone, for schedule searches that turn
 * thousands of wall times into instants. Offsets are sampled once per hour (cached) and every
 * change between two samples is located to the millisecond by bisection; no zone in the IANA
 * database changes its offset twice within an hour. A wall time then maps to zero instants (it
 * falls in a gap), one, or two (it is repeated) by plain arithmetic.
 */
import { findTransition, offsetAt } from '../time/zones';

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Larger than any UTC offset in the database (+14:00 and -12:00 since 1970; local mean time up to about 15:56). */
export const MAX_OFFSET_MS = 16 * HOUR;

export interface Transition {
  /** First millisecond at which `after` applies. */
  readonly at: number;
  readonly before: number;
  readonly after: number;
}

export type WallMapping =
  | { readonly kind: 'exact'; readonly epochMs: number; readonly offsetMs: number }
  | { readonly kind: 'repeated'; readonly first: { epochMs: number; offsetMs: number }; readonly second: { epochMs: number; offsetMs: number }; readonly transition: Transition }
  | { readonly kind: 'nonexistent'; readonly transition: Transition };

/**
 * Offsets and transition windows are facts about the zone, not about one search, so they are
 * cached per zone and shared by every timeline (bounded; cleared when large).
 */
interface ZoneCache {
  readonly hourly: Map<number, number>;
  readonly windows: Map<number, readonly Transition[]>;
}
const CACHES = new Map<string, ZoneCache>();
const MAX_HOURS_CACHED = 400_000;
const MAX_WINDOWS_CACHED = 20_000;

function cacheFor(zone: string): ZoneCache {
  let c = CACHES.get(zone);
  if (!c) {
    if (CACHES.size >= 64) CACHES.clear();
    c = { hourly: new Map(), windows: new Map() };
    CACHES.set(zone, c);
  }
  return c;
}

export class ZoneTimeline {
  private readonly hourly: Map<number, number>;
  private readonly windows: Map<number, readonly Transition[]>;

  constructor(readonly zone: string) {
    const c = cacheFor(zone);
    this.hourly = c.hourly;
    this.windows = c.windows;
  }

  /** Offset at the start of UTC hour `index` (epoch hours). */
  private offsetAtHour(index: number): number {
    let o = this.hourly.get(index);
    if (o === undefined) {
      o = offsetAt(index * HOUR, this.zone);
      if (this.hourly.size >= MAX_HOURS_CACHED) this.hourly.clear();
      this.hourly.set(index, o);
    }
    return o;
  }

  /** Every offset change in [from, to), in order. */
  transitionsBetween(from: number, to: number): Transition[] {
    const out: Transition[] = [];
    let hour = Math.floor(from / HOUR);
    const last = Math.ceil(to / HOUR);
    let prev = this.offsetAtHour(hour);
    for (hour += 1; hour <= last; hour++) {
      const cur = this.offsetAtHour(hour);
      if (cur !== prev) {
        const at = findTransition((hour - 1) * HOUR, hour * HOUR, this.zone);
        if (at >= from && at < to) out.push({ at, before: prev, after: cur });
        prev = cur;
      }
    }
    return out;
  }

  /** Transitions that can affect wall times on the UTC-numbered day containing `wallMs`. */
  private window(wallMs: number): readonly Transition[] {
    const day = Math.floor(wallMs / DAY);
    let w = this.windows.get(day);
    if (!w) {
      w = this.transitionsBetween(day * DAY - MAX_OFFSET_MS, (day + 1) * DAY + MAX_OFFSET_MS);
      if (this.windows.size >= MAX_WINDOWS_CACHED) this.windows.clear();
      this.windows.set(day, w);
    }
    return w;
  }

  /** The smallest and largest offsets in effect at any instant within MAX_OFFSET_MS of `ms`. */
  private offsetRange(ms: number): { min: number; max: number } {
    const w = this.window(ms);
    if (w.length === 0) {
      const o = this.offsetAtHour(Math.floor(ms / HOUR));
      return { min: o, max: o };
    }
    let min = w[0].before;
    let max = w[0].before;
    for (const t of w) {
      min = Math.min(min, t.after);
      max = Math.max(max, t.after);
    }
    return { min, max };
  }

  minOffsetNear(ms: number): number {
    return this.offsetRange(ms).min;
  }

  maxOffsetNear(ms: number): number {
    return this.offsetRange(ms).max;
  }

  /**
   * The instants at which clocks show `wallMs` (a wall time written as if it were UTC). Segments
   * between transitions each have one offset; a wall time belongs to a segment when the instant it
   * gives falls inside that segment.
   */
  map(wallMs: number): WallMapping {
    const transitions = this.window(wallMs);
    if (transitions.length === 0) {
      // One offset over the whole window, which contains every instant this wall time could be.
      const offset = this.offsetAtHour(Math.floor(wallMs / HOUR));
      return { kind: 'exact', epochMs: wallMs - offset, offsetMs: offset };
    }
    const hits: { epochMs: number; offsetMs: number }[] = [];
    for (let i = 0; i <= transitions.length; i++) {
      const offset = i === 0 ? transitions[0].before : transitions[i - 1].after;
      const lo = i === 0 ? -Infinity : transitions[i - 1].at;
      const hi = i === transitions.length ? Infinity : transitions[i].at;
      const t = wallMs - offset;
      if (t >= lo && t < hi) hits.push({ epochMs: t, offsetMs: offset });
    }
    if (hits.length === 1) return { kind: 'exact', ...hits[0] };
    if (hits.length >= 2) {
      const transition = transitions.find(tr => tr.at > hits[0].epochMs && tr.at <= hits[hits.length - 1].epochMs)!;
      return { kind: 'repeated', first: hits[0], second: hits[hits.length - 1], transition };
    }
    // A gap: the transition whose jump the wall time falls into.
    const transition = transitions.find(tr => tr.after > tr.before && wallMs >= tr.at + tr.before && wallMs < tr.at + tr.after) ?? transitions[0];
    return { kind: 'nonexistent', transition };
  }
}
