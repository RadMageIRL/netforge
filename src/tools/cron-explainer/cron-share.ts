/**
 * Cron Explainer settings links: the expression and its dialect, the time zone when one was
 * chosen, and the start of the run list. An expression is shared only when its dialect's parser
 * accepts it, and a link's expression is used only when it parses again here.
 */
import { parseCron } from '../../core/schedule/cron';
import { DIALECT_LABEL, type DialectId } from '../../core/schedule/model';
import { parseQuartz } from '../../core/schedule/quartz';
import { parseSystemd } from '../../core/schedule/systemd';
import { parseTimestamp } from '../../core/time/timestamp';
import { DEVICE_ZONE_NOTE, oneOf, onlyKeys, zoneName, type ShareOffer } from '../../app/share';

export interface CronShare {
  readonly dialect: DialectId;
  readonly expression: string;
  /** An explicit zone, or null for the device zone of whoever opens the link. */
  readonly zone: string | null;
  /** "List runs after", or null for now. */
  readonly from: string | null;
}

const KEYS = ['dialect', 'expr', 'tz', 'from'] as const;
const DIALECTS = ['cron', 'quartz', 'systemd'] as const;
export const MAX_EXPRESSION_CHARS = 200;
const MAX_FROM_CHARS = 40;

export function parsesAs(dialect: DialectId, text: string): boolean {
  if (dialect === 'cron') return parseCron(text).ok;
  if (dialect === 'quartz') return parseQuartz(text).ok;
  return parseSystemd(text).ok;
}

const validFrom = (from: string) => from.length <= MAX_FROM_CHARS && parseTimestamp(from, 'iso').ok;

export function cronOffer(s: CronShare): ShareOffer {
  const expression = s.expression.trim();
  if (expression === '') return { ok: false, reason: 'Enter an expression to put it in a link.' };
  if (expression.length > MAX_EXPRESSION_CHARS) return { ok: false, reason: `Expressions longer than ${MAX_EXPRESSION_CHARS} characters are not put in links.` };
  if (!parsesAs(s.dialect, expression)) return { ok: false, reason: 'Fix the expression to put it in a link.' };
  const params: [string, string][] = [['dialect', s.dialect], ['expr', expression]];
  const summary = [`${DIALECT_LABEL[s.dialect]} expression: ${expression}`];
  if (s.zone !== null) {
    params.push(['tz', s.zone]);
    summary.push(`Time zone: ${s.zone}`);
  } else summary.push(DEVICE_ZONE_NOTE);
  const from = s.from?.trim() ?? '';
  if (from !== '') {
    if (!validFrom(from)) return { ok: false, reason: 'Fix the "List runs after" time to put it in a link.' };
    params.push(['from', from]);
    summary.push(`Runs listed after: ${from}`);
  }
  return { ok: true, params, summary };
}

export function readCronShare(params: ReadonlyMap<string, string>): CronShare | null {
  if (!onlyKeys(params, KEYS)) return null;
  const dialect = params.has('dialect') ? oneOf(params.get('dialect'), DIALECTS) : 'cron';
  const expression = params.get('expr')?.trim();
  const zone = params.has('tz') ? zoneName(params.get('tz')) : null;
  const from = params.get('from')?.trim() ?? null;
  if (dialect === null || expression === undefined || expression === '' || (params.has('tz') && zone === null)) return null;
  if (expression.length > MAX_EXPRESSION_CHARS || !parsesAs(dialect, expression)) return null;
  if (from !== null && (from === '' || !validFrom(from))) return null;
  return { dialect, expression, zone, from };
}
