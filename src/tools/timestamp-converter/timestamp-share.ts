/**
 * Timestamp Converter settings links: the timestamp or date, how to read it, the time zone when
 * one was chosen, and which occurrence of a repeated local time. The device's own zone is never
 * written into a link.
 */
import { parseTimestamp, type TimestampMode } from '../../core/time/timestamp';
import { DEVICE_ZONE_NOTE, oneOf, onlyKeys, zoneName, type ShareOffer } from '../../app/share';

export interface TimestampShare {
  readonly text: string;
  readonly mode: TimestampMode;
  /** An explicit zone, or null for the device zone of whoever opens the link. */
  readonly zone: string | null;
  readonly pick: 'earlier' | 'later';
}

const KEYS = ['ts', 'mode', 'tz', 'pick'] as const;
const MODES = ['auto', 'seconds', 'milliseconds', 'iso'] as const;
const MODE_LABEL: Readonly<Record<TimestampMode, string>> = { auto: 'Auto', seconds: 'Seconds', milliseconds: 'Milliseconds', iso: 'ISO 8601' };
export const MAX_TIMESTAMP_CHARS = 64;

export function timestampOffer(s: TimestampShare): ShareOffer {
  const text = s.text.trim();
  if (text === '') return { ok: false, reason: 'Enter a timestamp or date to put it in a link.' };
  if (text.length > MAX_TIMESTAMP_CHARS || !parseTimestamp(text, s.mode).ok) return { ok: false, reason: 'Fix the timestamp to put it in a link.' };
  const params: [string, string][] = [['ts', text], ['mode', s.mode]];
  const summary = [`Timestamp: ${text}`, `Read as: ${MODE_LABEL[s.mode]}`];
  if (s.zone !== null) {
    params.push(['tz', s.zone]);
    summary.push(`Time zone: ${s.zone}`);
  } else summary.push(DEVICE_ZONE_NOTE);
  if (s.pick === 'later') {
    params.push(['pick', 'later']);
    summary.push('The later of a repeated local time');
  }
  return { ok: true, params, summary };
}

export function readTimestampShare(params: ReadonlyMap<string, string>): TimestampShare | null {
  if (!onlyKeys(params, KEYS)) return null;
  const text = params.get('ts');
  const mode = params.has('mode') ? oneOf(params.get('mode'), MODES) : 'auto';
  const zone = params.has('tz') ? zoneName(params.get('tz')) : null;
  const pick = params.has('pick') ? oneOf(params.get('pick'), ['earlier', 'later'] as const) : 'earlier';
  if (text === undefined || mode === null || (params.has('tz') && zone === null) || pick === null) return null;
  if (text.trim() === '' || text.length > MAX_TIMESTAMP_CHARS || !parseTimestamp(text, mode).ok) return null;
  return { text: text.trim(), mode, zone, pick };
}
