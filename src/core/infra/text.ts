/**
 * Checks for the values a person types into an export form (server names, DNS servers, MAC
 * addresses) and for plan text that is about to be written into generated configuration.
 *
 * The rule for plan text: a name or description either fits the target's syntax as it is, or
 * fits after one stated change (spaces to underscores), or it is left out and reported. Text is
 * never escaped in a way that could not be checked against the real platform, and nothing that
 * could end a line or a quoted string is ever written.
 */
import { formatAddress, parseAddress } from '../net/address';

/** C0 and C1 controls, DEL, and the Unicode line and paragraph separators. */
export const CONTROL = new RegExp(`[\x00-\x1f\x7f-\x9f${String.fromCharCode(0x2028, 0x2029)}]`);

export function hasControl(text: string): boolean {
  return CONTROL.test(text);
}

/** Printable ASCII: space to tilde. */
export function isPrintableAscii(text: string): boolean {
  return /^[ -~]*$/.test(text);
}

export const MAX_DNS_SERVERS = 8;

export type ListResult = { readonly ok: true; readonly values: readonly string[] } | { readonly ok: false; readonly message: string };

/** IPv4 addresses separated by commas or spaces, in canonical form, without duplicates. */
export function parseDnsServers(text: string): ListResult {
  const parts = text.split(/[\s,]+/).filter(p => p !== '');
  if (parts.length > MAX_DNS_SERVERS) return { ok: false, message: `Enter at most ${MAX_DNS_SERVERS} DNS servers.` };
  const values: string[] = [];
  for (const part of parts) {
    const a = parseAddress(part, 4);
    if (!a.ok) return { ok: false, message: `"${part.slice(0, 40)}" is not an IPv4 address.` };
    const shown = formatAddress(4, a.value.value);
    if (values.includes(shown)) return { ok: false, message: `${shown} is listed twice.` };
    values.push(shown);
  }
  return { ok: true, values };
}

const LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A DNS name: labels of letters, digits and hyphens, 253 characters at most. Null when valid. */
export function checkDnsName(name: string): string | null {
  if (name.length > 253) return 'Keep the name to 253 characters.';
  const labels = name.split('.');
  for (const label of labels) {
    if (!LABEL.test(label)) return 'Use letters, digits and hyphens in each part of the name, separated by dots.';
  }
  return null;
}

/** A server to pass as -ComputerName: a DNS name or an IPv4 address. Null when valid. */
export function checkComputerName(name: string): string | null {
  if (parseAddress(name, 4).ok) return null;
  return checkDnsName(name);
}

/** A MAC address in any common spelling, as twelve lowercase hex digits; null when it is not one. */
export function parseMac(text: string): string | null {
  const t = text.trim();
  const forms = [/^[0-9A-Fa-f]{12}$/, /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/, /^[0-9A-Fa-f]{2}(-[0-9A-Fa-f]{2}){5}$/, /^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$/];
  if (!forms.some(f => f.test(t))) return null;
  return t.replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
}

export function macWithDashes(mac12: string): string {
  return (mac12.match(/../g) ?? []).join('-');
}

export type TokenResult =
  | { readonly kind: 'exact'; readonly value: string }
  | { readonly kind: 'approximate'; readonly value: string; readonly change: string }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * A plan name as a one-word device identifier. Exact when it already matches `pattern`; otherwise
 * runs of spaces become `filler` and the result is approximate; otherwise refused.
 */
export function nameToken(name: string, pattern: RegExp, maxLength: number, filler: string): TokenResult {
  if (name === '') return { kind: 'refused', reason: 'it is empty' };
  if (pattern.test(name) && name.length <= maxLength) return { kind: 'exact', value: name };
  const joined = name.replace(/ +/g, filler);
  if (joined !== name && pattern.test(joined) && joined.length <= maxLength) return { kind: 'approximate', value: joined, change: `spaces written as "${filler}"` };
  if (name.length > maxLength && pattern.test(joined)) return { kind: 'refused', reason: `it is longer than ${maxLength} characters` };
  return { kind: 'refused', reason: 'it has characters the platform does not accept in a name' };
}

/** Lowercase letters, digits and underscores, for names NetForge invents (Terraform resource names). */
export function slug(text: string, maxLength = 40): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, maxLength).replace(/_+$/, '');
}
