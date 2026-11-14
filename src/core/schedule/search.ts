/**
 * Next-run search. A schedule produces local wall times in increasing order; each is mapped to
 * instants in the chosen zone (zero, one or two), the dialect's DST policy marks what happens at
 * skipped and repeated times, and rows come out in instant order.
 *
 * Bounded: dates are scanned at most SEARCH_YEARS ahead (a full Gregorian cycle, after which every
 * date pattern without a year repeats) and never past the dialect's last year, and at most
 * MAX_WALL_TIMES candidate times are examined. A search that ends early says why.
 */
import { daysInMonth } from './calendar';
import type { CalendarPattern, DstOutcome, DstPolicy } from './model';
import { ZoneTimeline, type Transition } from './zone-timeline';
import { utcFromWall, wallFromUtc } from '../time/zones';

export const SEARCH_YEARS = 400;
export const MAX_WALL_TIMES = 500_000;
export const DEFAULT_RUN_COUNT = 10;
const DAY = 86_400_000;

export type RunKind = 'normal' | 'repeated-first' | 'repeated-second';

/** A time the schedule produces that has an instant. */
export interface RunRow {
  readonly type: 'run';
  /** 1-based position among counted runs; null for a run the policy marks as skipped. */
  readonly index: number | null;
  readonly wallMs: number;
  readonly epochMs: number;
  readonly offsetMs: number;
  readonly kind: RunKind;
  readonly outcome: DstOutcome;
  readonly transition: Transition | null;
}

/** Scheduled local times that do not exist, or repeated times the policy skips, collapsed per transition. */
export interface GroupRow {
  readonly type: 'group';
  readonly kind: 'nonexistent' | 'repeated-second';
  readonly outcome: DstOutcome;
  readonly firstWallMs: number;
  readonly lastWallMs: number;
  readonly count: number;
  readonly transition: Transition;
}

export type ScheduleRow = RunRow | GroupRow;

export type StopReason =
  | { readonly kind: 'never' }
  /** Every year the expression allows is before the start. */
  | { readonly kind: 'past' }
  /** A one-time trigger (and its repetitions) has no more runs. */
  | { readonly kind: 'ended' }
  | { readonly kind: 'last-year'; readonly year: number }
  | { readonly kind: 'horizon'; readonly years: number }
  | { readonly kind: 'limit'; readonly examined: number };

export interface NextRuns {
  readonly zone: string;
  readonly fromMs: number;
  readonly rows: readonly ScheduleRow[];
  /** Counted runs found (at most the requested count). */
  readonly found: number;
  /** Why fewer runs than requested were found; null when the count was reached. */
  readonly stop: StopReason | null;
}

interface Pending {
  readonly key: number;
  /** Orders a gap before a run at the same instant. */
  readonly order: number;
  readonly row: Omit<RunRow, 'index'> | GroupRow;
}

function insertSorted(list: Pending[], item: Pending): void {
  const last = list[list.length - 1];
  if (!last || last.key < item.key || (last.key === item.key && last.order <= item.order)) {
    list.push(item);
    return;
  }
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const m = list[mid];
    if (m.key < item.key || (m.key === item.key && m.order <= item.order)) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, item);
}

/**
 * Runs the search over `walls` (wall times written as UTC milliseconds, strictly increasing).
 * Returns the rows and whether the wall source was exhausted.
 */
export function collectRuns(walls: Iterator<number>, zone: string, fromMs: number, count: number, policy: DstPolicy, timeline = new ZoneTimeline(zone)):
  { rows: ScheduleRow[]; found: number; exhausted: boolean; examined: number } {
  const rows: ScheduleRow[] = [];
  const pending: Pending[] = [];
  let found = 0;
  let examined = 0;
  let exhausted = false;

  const emit = (p: Pending) => {
    const r = p.row;
    if (r.type === 'run') {
      const counted = r.outcome !== 'skipped';
      if (counted) found++;
      const run: RunRow = { ...r, index: counted ? found : null };
      if (!counted && run.kind === 'repeated-second' && run.transition) {
        const prev = rows[rows.length - 1];
        if (prev && prev.type === 'group' && prev.kind === 'repeated-second' && prev.transition.at === run.transition.at) {
          rows[rows.length - 1] = { ...prev, lastWallMs: run.wallMs, count: prev.count + 1 };
          return;
        }
        rows.push({ type: 'group', kind: 'repeated-second', outcome: 'skipped', firstWallMs: run.wallMs, lastWallMs: run.wallMs, count: 1, transition: run.transition });
        return;
      }
      rows.push(run);
      return;
    }
    const prev = rows[rows.length - 1];
    if (prev && prev.type === 'group' && prev.kind === r.kind && prev.transition.at === r.transition.at) {
      rows[rows.length - 1] = { ...prev, lastWallMs: r.lastWallMs, count: prev.count + 1 };
      return;
    }
    rows.push(r);
  };

  const flush = (limit: number) => {
    while (pending.length > 0 && found < count && pending[0].key < limit) emit(pending.shift()!);
  };

  for (;;) {
    const next = walls.next();
    if (next.done) {
      exhausted = true;
      break;
    }
    const wallMs = next.value;
    examined++;
    // Rows whose instant is before every instant a later wall time can have are final.
    flush(wallMs - timeline.maxOffsetNear(wallMs));
    if (found >= count) break;
    if (examined > MAX_WALL_TIMES) break;
    const m = timeline.map(wallMs);
    if (m.kind === 'exact') {
      if (m.epochMs > fromMs) insertSorted(pending, pendingRun(wallMs, m.epochMs, m.offsetMs, 'normal', 'runs', null));
    } else if (m.kind === 'repeated') {
      if (m.first.epochMs > fromMs) insertSorted(pending, pendingRun(wallMs, m.first.epochMs, m.first.offsetMs, 'repeated-first', policy.repeatedFirst, m.transition));
      if (m.second.epochMs > fromMs) {
        // Starting inside the second pass, a scheduler that walks local time forward meets this time only once.
        const inside = fromMs >= m.transition.at && policy.repeatedSecondFromInside !== undefined;
        insertSorted(pending, pendingRun(wallMs, m.second.epochMs, m.second.offsetMs, 'repeated-second', inside ? policy.repeatedSecondFromInside! : policy.repeatedSecond, m.transition));
      }
    } else if (m.transition.at > fromMs) {
      const row: GroupRow = { type: 'group', kind: 'nonexistent', outcome: policy.nonexistent, firstWallMs: wallMs, lastWallMs: wallMs, count: 1, transition: m.transition };
      insertSorted(pending, { key: m.transition.at, order: 0, row });
    }
  }
  if (found < count && examined <= MAX_WALL_TIMES) flush(Infinity);
  return { rows, found, exhausted, examined };
}

function pendingRun(wallMs: number, epochMs: number, offsetMs: number, kind: RunKind, outcome: DstOutcome, transition: Transition | null): Pending {
  return { key: epochMs, order: 1, row: { type: 'run', wallMs, epochMs, offsetMs, kind, outcome, transition } };
}

/**
 * Wall times of a calendar pattern at or after `startWallMs`, in increasing order, through the end
 * of `lastYear`. Whole years and months that cannot match are skipped without visiting their days.
 */
export function* patternWalls(p: CalendarPattern, startWallMs: number, lastYear: number): Generator<number> {
  const start = wallFromUtc(startWallMs);
  const startSecondOfDay = start.hour * 3600 + start.minute * 60 + start.second + (start.millisecond > 0 ? 1 : 0);
  const times: number[] = [];
  for (const h of p.hours) for (const m of p.minutes) for (const s of p.seconds) times.push(h * 3600 + m * 60 + s);
  if (times.length === 0) return;
  for (let year = start.year; year <= lastYear; year++) {
    if (!p.yearMatches(year)) continue;
    const firstYear = year === start.year;
    for (let month = firstYear ? start.month : 1; month <= 12; month++) {
      if (!p.months.has(month)) continue;
      const firstMonth = firstYear && month === start.month;
      const last = daysInMonth(year, month);
      for (let day = firstMonth ? start.day : 1; day <= last; day++) {
        if (!p.dayMatches(year, month, day)) continue;
        const dayMs = utcFromWall({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 });
        const isStartDay = firstMonth && day === start.day;
        for (const t of times) {
          if (isStartDay && t < startSecondOfDay) continue;
          yield dayMs + t * 1000;
        }
      }
    }
  }
}

/** True when the pattern matches at least one date in a full 400-year cycle (ignoring its year rule). */
export function patternHasDates(p: CalendarPattern): boolean {
  for (let year = 2000; year < 2400; year++) {
    for (const month of p.months) {
      const last = daysInMonth(year, month);
      for (let day = 1; day <= last; day++) if (p.dayMatches(year, month, day)) return true;
    }
  }
  return false;
}

function anyYearFrom(p: CalendarPattern, fromYear: number): boolean {
  for (let y = fromYear; y <= p.lastYear; y++) if (p.yearMatches(y)) return true;
  return false;
}

export interface SearchOptions {
  readonly count?: number;
}

/** The next runs of a calendar pattern after `fromMs` in `zone`, under `policy`. */
export function nextPatternRuns(p: CalendarPattern, zone: string, fromMs: number, policy: DstPolicy, options: SearchOptions = {}): NextRuns {
  const count = options.count ?? DEFAULT_RUN_COUNT;
  const timeline = new ZoneTimeline(zone);
  // The earliest wall time that can be an instant after `fromMs`.
  const startWall = fromMs + timeline.minOffsetNear(fromMs);
  const fromYear = wallFromUtc(startWall).year;
  const horizon = Math.min(p.lastYear, fromYear + SEARCH_YEARS);
  const walls = patternWalls(p, startWall, horizon);
  const r = collectRuns(walls, zone, fromMs, count, policy, timeline);
  let stop: StopReason | null = null;
  if (r.found < count) {
    if (!r.exhausted) stop = { kind: 'limit', examined: r.examined };
    else if (r.found === 0 && !patternHasDates(p)) stop = { kind: 'never' };
    else if (r.found === 0 && !anyYearFrom(p, fromYear)) stop = { kind: 'past' };
    else if (horizon === p.lastYear) stop = { kind: 'last-year', year: p.lastYear };
    else stop = r.found === 0 ? { kind: 'never' } : { kind: 'horizon', years: SEARCH_YEARS };
  }
  return { zone, fromMs, rows: r.rows, found: r.found, stop };
}

export { DAY as MS_PER_DAY };
