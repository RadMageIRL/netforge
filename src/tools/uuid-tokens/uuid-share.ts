/**
 * UUID / Random Tokens settings links: what to generate, how many and how long. Never a generated
 * value, and opening a link generates nothing: it fills in the options and waits for Generate.
 */
import { TOKEN_LIMITS, type TokenKind } from '../../core/random/tokens';
import { intIn, oneOf, onlyKeys, type ShareOffer } from '../../app/share';

export interface TokenShare {
  readonly kind: TokenKind;
  readonly count: number;
  /** Bytes per token; null for UUIDs, which have a fixed size. */
  readonly bytes: number | null;
}

export const TOKEN_KIND_LABEL: Readonly<Record<TokenKind, string>> = {
  'uuid-v4': 'UUID version 4 (random)',
  'uuid-v7': 'UUID version 7 (time-ordered)',
  hex: 'Random token, hexadecimal',
  base64url: 'Random token, Base64URL',
};

const KINDS = Object.keys(TOKEN_KIND_LABEL) as TokenKind[];
const KEYS = ['kind', 'count', 'bytes'] as const;
const isToken = (kind: TokenKind) => kind === 'hex' || kind === 'base64url';

export function tokenOffer(kind: TokenKind, countText: string, bytesText: string): ShareOffer {
  const count = intIn(countText.trim(), TOKEN_LIMITS.minCount, TOKEN_LIMITS.maxCount);
  if (count === null) return { ok: false, reason: `Enter how many to generate, from ${TOKEN_LIMITS.minCount} to ${TOKEN_LIMITS.maxCount}, to put the options in a link.` };
  const params: [string, string][] = [['kind', kind], ['count', String(count)]];
  const summary = [`Generate: ${TOKEN_KIND_LABEL[kind]}`, `How many: ${count}`];
  if (isToken(kind)) {
    const bytes = intIn(bytesText.trim(), TOKEN_LIMITS.minBytes, TOKEN_LIMITS.maxBytes);
    if (bytes === null) return { ok: false, reason: `Enter the bytes per token, from ${TOKEN_LIMITS.minBytes} to ${TOKEN_LIMITS.maxBytes}, to put the options in a link.` };
    params.push(['bytes', String(bytes)]);
    summary.push(`Bytes per token: ${bytes}`);
  }
  summary.push('Not included: any generated value. Opening the link generates nothing.');
  return { ok: true, params, summary };
}

export function readTokenShare(params: ReadonlyMap<string, string>): TokenShare | null {
  if (!onlyKeys(params, KEYS)) return null;
  const kind = oneOf(params.get('kind'), KINDS);
  if (kind === null) return null;
  const count = params.has('count') ? intIn(params.get('count'), TOKEN_LIMITS.minCount, TOKEN_LIMITS.maxCount) : 1;
  if (count === null) return null;
  if (!isToken(kind)) return params.has('bytes') ? null : { kind, count, bytes: null };
  const bytes = params.has('bytes') ? intIn(params.get('bytes'), TOKEN_LIMITS.minBytes, TOKEN_LIMITS.maxBytes) : 32;
  return bytes === null ? null : { kind, count, bytes };
}
