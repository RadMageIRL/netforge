/**
 * Time zone arithmetic on top of Intl (the browser's IANA time zone database). Instants are epoch
 * milliseconds; wall times are calendar fields in the proleptic Gregorian calendar.
 */

export interface WallTime {
  /** Astronomical year: 0 is 1 BC. */
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

export const MS_PER_DAY = 86_400_000;

/** Epoch milliseconds of a wall time read as UTC. Years 0 to 99 are handled literally (Date.UTC maps them to 1900 to 1999). */
export function utcFromWall(w: WallTime): number {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, w.millisecond);
  return d.getTime();
}

export function wallFromUtc(epochMs: number): WallTime {
  const d = new Date(epochMs);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), millisecond: d.getUTCMilliseconds(),
  };
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partFormatter(zone: string): Intl.DateTimeFormat {
  let f = partFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23', era: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    partFormatters.set(zone, f);
  }
  return f;
}

/** True when the browser knows `zone` as an IANA time zone name (or alias). */
export function isValidTimeZone(zone: string): boolean {
  if (zone === '' || zone.length > 64) return false;
  try {
    partFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The canonical IANA name for `zone` (for example, an alias or a lowercase spelling maps to its target). */
export function canonicalTimeZone(zone: string): string {
  return currentZoneName(partFormatter(zone).resolvedOptions().timeZone);
}

/** The wall time shown by clocks in `zone` at the instant `epochMs`. */
export function wallInZone(epochMs: number, zone: string): WallTime {
  const parts = partFormatter(zone).formatToParts(new Date(epochMs));
  let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  let bc = false;
  for (const p of parts) {
    switch (p.type) {
      case 'year': year = Number(p.value); break;
      case 'month': month = Number(p.value); break;
      case 'day': day = Number(p.value); break;
      case 'hour': hour = Number(p.value) % 24; break;
      case 'minute': minute = Number(p.value); break;
      case 'second': second = Number(p.value); break;
      case 'era': bc = p.value.startsWith('B'); break;
      default: break;
    }
  }
  if (bc) year = 1 - year;
  const millisecond = ((epochMs % 1000) + 1000) % 1000;
  return { year, month, day, hour, minute, second, millisecond };
}

/** UTC offset of `zone` at `epochMs`, in milliseconds (local wall time minus UTC). */
export function offsetAt(epochMs: number, zone: string): number {
  return utcFromWall(wallInZone(epochMs, zone)) - epochMs;
}

export interface ZonedInstant {
  readonly epochMs: number;
  readonly offsetMs: number;
}

export type WallResolution =
  | { readonly kind: 'exact'; readonly instant: ZonedInstant }
  /** The wall time happens twice, as clocks are set back. */
  | { readonly kind: 'ambiguous'; readonly earlier: ZonedInstant; readonly later: ZonedInstant; readonly transitionMs: number }
  /** The wall time never happens, as clocks jump forward over it. */
  | { readonly kind: 'gap'; readonly offsetBeforeMs: number; readonly offsetAfterMs: number; readonly transitionMs: number };

/**
 * Finds every instant at which clocks in `zone` show the wall time `w`. Offsets are sampled a day
 * either side of the wall time (no zone changes its offset by more than a day at once), and each
 * candidate is kept only if it really displays `w`.
 */
export function resolveWall(w: WallTime, zone: string): WallResolution {
  const asUtc = utcFromWall(w);
  const offsets = new Set<number>();
  const before = offsetAt(asUtc - MS_PER_DAY, zone);
  const after = offsetAt(asUtc + MS_PER_DAY, zone);
  const here = offsetAt(asUtc, zone);
  offsets.add(before).add(after).add(here).add(offsetAt(asUtc - here, zone));
  const instants = [...offsets]
    .map(offset => asUtc - offset)
    .filter(t => offsetAt(t, zone) === asUtc - t)
    .sort((a, b) => a - b);
  const unique = [...new Set(instants)];
  if (unique.length === 0) {
    return { kind: 'gap', offsetBeforeMs: before, offsetAfterMs: after, transitionMs: findTransition(asUtc - MS_PER_DAY, asUtc + MS_PER_DAY, zone) };
  }
  if (unique.length === 1) return { kind: 'exact', instant: { epochMs: unique[0], offsetMs: asUtc - unique[0] } };
  const earlier = unique[0];
  const later = unique[unique.length - 1];
  return {
    kind: 'ambiguous',
    earlier: { epochMs: earlier, offsetMs: asUtc - earlier },
    later: { epochMs: later, offsetMs: asUtc - later },
    transitionMs: findTransition(earlier, later, zone),
  };
}

/**
 * The first millisecond in (lo, hi] whose offset differs from the offset at `lo`, by bisection.
 * Callers pass a range that contains exactly one transition.
 */
export function findTransition(lo: number, hi: number, zone: string): number {
  const start = offsetAt(lo, zone);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid, zone) === start) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** "+05:30", "-04:00", "+00:00"; seconds are shown only when an offset has them (old local mean time). */
export function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  const total = Math.round(Math.abs(offsetMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const base = `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return s === 0 ? base : `${base}:${String(s).padStart(2, '0')}`;
}

/**
 * Browsers take zone identifiers from CLDR, which keeps these older names after IANA renamed them,
 * so an engineer in India would otherwise see Asia/Calcutta and find no Asia/Kolkata in the list.
 * Each pair is an IANA "backward" link: the same zone, so the browser accepts either name.
 */
export const CURRENT_ZONE_NAMES: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** The current IANA name for a zone the browser may report under an older name. */
export function currentZoneName(zone: string): string {
  return CURRENT_ZONE_NAMES[zone] ?? zone;
}

/** Every time zone the browser knows, under current IANA names, always including UTC, sorted. */
export function listTimeZones(): string[] {
  const zones = new Set<string>(['UTC']);
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (supported) for (const z of supported('timeZone')) zones.add(currentZoneName(z));
  return [...zones].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b, 'en')));
}

/** The browser's own time zone under its current IANA name, or UTC when it cannot say. */
export function browserTimeZone(): string {
  try {
    return currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  } catch {
    return 'UTC';
  }
}
