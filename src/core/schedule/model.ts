/**
 * Types shared by the scheduling models. Each dialect keeps its own parser, rules and parsed form;
 * `CalendarPattern` is the shared normalized representation, used only where a dialect's meaning
 * can be stated exactly as "these times of day, on the dates this predicate accepts".
 */
import type { Fail, ValidationError } from '../result';

/** Expression dialects. Windows Task Scheduler triggers are structured, not text, and live in windows.ts. */
export type DialectId = 'cron' | 'quartz' | 'systemd';
export type ScheduleModelId = DialectId | 'windows';

export const DIALECT_LABEL: Readonly<Record<ScheduleModelId, string>> = {
  cron: 'Standard cron',
  quartz: 'Quartz cron',
  systemd: 'systemd calendar',
  windows: 'Windows Task Scheduler',
};

export interface ScheduleError<C extends string = string> extends ValidationError<C> {
  /** Length of the offending text in UTF-16 units, starting at `offset`. */
  readonly length?: number;
  /** The field the error is about ("day-of-week"), when there is one. */
  readonly field?: string;
}

export function scheduleFail<C extends string>(code: C, message: string, offset?: number, length?: number, field?: string): Fail<C> {
  const error: ScheduleError<C> = { code, message, ...(offset === undefined ? {} : { offset }), ...(length === undefined ? {} : { length }), ...(field === undefined ? {} : { field }) };
  return { ok: false, error };
}

/** One field of a parsed expression, explained. */
export interface FieldExplanation {
  /** "Minute", "Day of month", "Weekday". */
  readonly field: string;
  /** The text as written, after nickname or shorthand expansion. */
  readonly text: string;
  /** What it means in words. */
  readonly meaning: string;
  /** The values it matches, compactly ("0, 15, 30, 45"), or a rule ("the last Friday"). */
  readonly values: string;
}

export interface Explanation {
  /** One sentence. */
  readonly summary: string;
  readonly fields: readonly FieldExplanation[];
  /** Traps and surprises worth knowing before relying on the schedule. */
  readonly warnings: readonly string[];
  /** Neutral facts about how the dialect reads the expression. */
  readonly notes: readonly string[];
  /** A normalized or expanded form, when the dialect has one (systemd normalization, cron nicknames). */
  readonly normalized: string | null;
}

/**
 * The shared normalized form. Times of day are sorted and unique; the date rule is the dialect's
 * own (cron's OR rule, Quartz's L/W/#, systemd's weekday AND date, ...).
 */
export interface CalendarPattern {
  readonly seconds: readonly number[];
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  /** Months that can match, 1 to 12. */
  readonly months: ReadonlySet<number>;
  /** The last year the dialect can schedule (Quartz 2099, systemd 2199, cron 9999). */
  readonly lastYear: number;
  yearMatches(year: number): boolean;
  /** Called only for years and months that match. */
  dayMatches(year: number, month: number, day: number): boolean;
}

/** How a scheduler treats local times that DST changes skip or repeat. */
export type DstOutcome = 'runs' | 'skipped' | 'uncertain';

export interface DstPolicy {
  /** A local time that does not exist (clocks jump over it). */
  readonly nonexistent: Exclude<DstOutcome, 'runs'>;
  /** The first time clocks show a repeated local time. */
  readonly repeatedFirst: DstOutcome;
  /** The second time clocks show a repeated local time. */
  readonly repeatedSecond: DstOutcome;
  /**
   * The second pass when the listing starts inside it (after clocks went back, before that time
   * comes round again). Defaults to `repeatedSecond`.
   */
  readonly repeatedSecondFromInside?: DstOutcome;
  readonly repeatedFromInsideNote?: string;
  /** What the outcomes rest on, for the notes. */
  readonly basis: string;
  readonly nonexistentNote: string;
  readonly repeatedNote: string;
}

export function sortedUnique(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** "0-4, 9, 12-14" for a sorted list. */
export function compactList(values: readonly number[], format: (n: number) => string = String): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    if (j - i >= 2) parts.push(`${format(values[i])}-${format(values[j])}`);
    else for (let k = i; k <= j; k++) parts.push(format(values[k]));
    i = j;
  }
  return parts.join(', ');
}
