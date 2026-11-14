/**
 * Proleptic Gregorian calendar arithmetic for schedule matching: leap years, month lengths,
 * weekdays, nth and last weekdays, and Quartz's nearest-weekday rule. Pure integer math, no Date.
 */

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days since 1970-01-01 for a civil date (H. Hinnant's days_from_civil). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export interface CivilDate { readonly year: number; readonly month: number; readonly day: number }

/** The civil date `days` after 1970-01-01. */
export function civilFromDays(days: number): CivilDate {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** Day of the week, 0 = Sunday to 6 = Saturday. */
export function weekday(year: number, month: number, day: number): number {
  return (((daysFromCivil(year, month, day) + 4) % 7) + 7) % 7;
}

/** The day of the month of the nth (1 to 5) `dow` (0 = Sunday) in a month, or null when there is none. */
export function nthWeekday(year: number, month: number, dow: number, n: number): number | null {
  const first = weekday(year, month, 1);
  const day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  return day <= daysInMonth(year, month) ? day : null;
}

/** The day of the month of the last `dow` (0 = Sunday) in a month. */
export function lastWeekday(year: number, month: number, dow: number): number {
  const last = daysInMonth(year, month);
  return last - ((weekday(year, month, last) - dow + 7) % 7);
}

/** The last Monday-to-Friday day of a month. */
export function lastBusinessDay(year: number, month: number): number {
  const last = daysInMonth(year, month);
  const dow = weekday(year, month, last);
  return dow === 6 ? last - 1 : dow === 0 ? last - 2 : last;
}

/**
 * Quartz's "nW": the weekday nearest to day `day` without leaving the month. A Saturday moves to
 * Friday, except the 1st, which moves to Monday the 3rd; a Sunday moves to Monday, except the last
 * day of the month, which moves to Friday. Callers keep `day` within the month.
 */
export function nearestWeekday(year: number, month: number, day: number): number {
  const dow = weekday(year, month, day);
  const last = daysInMonth(year, month);
  if (dow === 6) return day === 1 ? 3 : day - 1;
  if (dow === 0) return day === last ? day - 2 : day + 1;
  return day;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function formatDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function formatClock(hour: number, minute: number, second?: number): string {
  return second === undefined ? `${pad(hour)}:${pad(minute)}` : `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[], conjunction = 'and'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}
