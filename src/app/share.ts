/**
 * Share links. A link to a tool is the public address with the tool's route: #/subnet-calculator.
 * A tool that has harmless settings can also put them after the route, behind a version number:
 * #/subnet-calculator?v=1&ip=192.0.2.10/24&split=26. Everything is in the fragment, so browsers
 * never send it to any server, and it is written only when someone asks for a link.
 *
 * Reading a link never trusts it. The whole settings part is refused when it is too long, cannot
 * be decoded, repeats a key, names a key the tool does not know, carries a version this build does
 * not read, or has any value the tool's own parser rejects. A refused link opens the tool with its
 * defaults and says why; nothing from it reaches the page.
 */

/** The one address links are written with, wherever this copy of NetForge is running. */
export const SHARE_ORIGIN = 'https://netforge.radmagelabs.com/';
/** The RadMage Labs homepage. */
export const LABS_URL = 'https://radmagelabs.com/';
/** The settings format this build writes and reads. */
export const SHARE_VERSION = '1';
/** No link longer than this is written, and no fragment longer than this is read. */
export const MAX_LINK_CHARS = 1024;
/** Longest single value, after decoding. */
export const MAX_VALUE_CHARS = 256;
/** Most settings in one link, the version included. */
export const MAX_PARAMS = 16;

const KEY = /^[a-z][a-z0-9]{0,11}$/;
/** Printable ASCII only: no control characters, no line breaks, nothing that renders deceptively. */
const PRINTABLE = /^[\x20-\x7e]*$/;

export type ShareParams = readonly (readonly [key: string, value: string])[];

/** What a settings link would carry right now, or why there is none. */
export type ShareOffer =
  | { readonly ok: true; readonly params: ShareParams; readonly summary: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export type RefusedReason = 'too-long' | 'malformed' | 'version' | 'duplicate';

export type ShareRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly reason: RefusedReason }
  | { readonly kind: 'settings'; readonly params: ReadonlyMap<string, string> };

export const REFUSED_TEXT: Readonly<Record<RefusedReason | 'invalid' | 'unsupported', string>> = {
  'too-long': 'the link is longer than NetForge reads',
  malformed: 'part of the link could not be read',
  version: 'the link was made by a version of NetForge that wrote settings differently',
  duplicate: 'the link names the same setting twice',
  invalid: 'one of its settings is not valid for this tool',
  unsupported: 'this tool never takes settings from a link',
};

/** The link to a tool: its route and nothing else. */
export function toolLink(id: string): string {
  return `${SHARE_ORIGIN}#/${id}`;
}

/** The link to NetForge's home page. */
export function homeLink(): string {
  return SHARE_ORIGIN;
}

/** Percent-encodes a value, leaving the characters that read naturally in a link and mean nothing to the reader below. */
export function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%40/g, '@');
}

/**
 * The link to a tool with settings, or null when the settings would make it longer than
 * MAX_LINK_CHARS or break the format (a bad key, a repeated key, a value that is too long or not
 * printable). Tools build their params from validated state, so null means "too long" in practice.
 */
export function settingsLink(id: string, params: ShareParams): string | null {
  if (params.length + 1 > MAX_PARAMS) return null;
  const seen = new Set<string>(['v']);
  for (const [key, value] of params) {
    if (!KEY.test(key) || seen.has(key) || value.length > MAX_VALUE_CHARS || !PRINTABLE.test(value)) return null;
    seen.add(key);
  }
  const link = `${toolLink(id)}?${[`v=${SHARE_VERSION}`, ...params.map(([k, v]) => `${k}=${encodeValue(v)}`)].join('&')}`;
  return link.length <= MAX_LINK_CHARS ? link : null;
}

/** The settings part of an address's fragment, judged as a whole. */
export function readShareQuery(hash: string): ShareRead {
  const at = hash.indexOf('?');
  if (at < 0 || at === hash.length - 1) return { kind: 'none' };
  if (hash.length > MAX_LINK_CHARS) return { kind: 'refused', reason: 'too-long' };
  const parts = hash.slice(at + 1).split('&');
  if (parts.length > MAX_PARAMS) return { kind: 'refused', reason: 'too-long' };
  const params = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) return { kind: 'refused', reason: 'malformed' };
    const key = part.slice(0, eq);
    if (!KEY.test(key)) return { kind: 'refused', reason: 'malformed' };
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return { kind: 'refused', reason: 'malformed' };
    }
    if (!PRINTABLE.test(value)) return { kind: 'refused', reason: 'malformed' };
    if (value.length > MAX_VALUE_CHARS) return { kind: 'refused', reason: 'too-long' };
    if (params.has(key)) return { kind: 'refused', reason: 'duplicate' };
    params.set(key, value);
  }
  if (params.get('v') !== SHARE_VERSION) return { kind: 'refused', reason: 'version' };
  params.delete('v');
  return { kind: 'settings', params };
}

/** Said in place of a zone the link leaves out: the device's own zone is never written into a link. */
export const DEVICE_ZONE_NOTE = 'Time zone: not included, so the link opens in the time zone of the device that opens it. Choose a zone to include one.';

// ---- Helpers for the tools' own readers ---------------------------------------------------

/** True when every key in params is one of allowed (unknown keys make a link unusable). */
export function onlyKeys(params: ReadonlyMap<string, string>, allowed: readonly string[]): boolean {
  for (const key of params.keys()) if (!allowed.includes(key)) return false;
  return true;
}

/** A whole number written in plain digits within [min, max], or null. */
export function intIn(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || !/^\d{1,7}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** value when it is exactly one of choices, or null. */
export function oneOf<T extends string>(value: string | undefined, choices: readonly T[]): T | null {
  return value !== undefined && (choices as readonly string[]).includes(value) ? (value as T) : null;
}

/** A plausible IANA zone name; the tool still checks that this browser lists it. */
export function zoneName(value: string | undefined): string | null {
  return value !== undefined && /^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,3})$/.test(value) && value.length <= 64 ? value : null;
}
