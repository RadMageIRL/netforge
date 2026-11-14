/**
 * IPv6 text parsing (RFC 4291 section 2.2) and canonical formatting (RFC 5952). Values are
 * unsigned 128-bit integers held as bigint.
 */
import { fail, ok, type Result } from '../result';
import { describeCharAt } from '../text';
import { formatIPv4, parseIPv4 } from './ipv4';

export const IPV6_BITS = 128;
export const IPV6_MAX = (1n << 128n) - 1n;

export type IPv6ErrorCode =
  | 'empty'
  | 'bracketed'
  | 'zone-id'
  | 'no-colon'
  | 'invalid-char'
  | 'double-compression'
  | 'empty-group'
  | 'group-too-long'
  | 'group-count'
  | 'ipv4-tail'
  | 'ipv4-position';

const HEX = /^[0-9a-fA-F]{1,4}$/;

/**
 * Parses any RFC 4291 text form: full, '::'-compressed, leading zeros in a group, upper or lower
 * case, and an embedded dotted IPv4 address in the last 32 bits. Zone indexes (%eth0) and
 * brackets are rejected with an explanation rather than silently stripped.
 */
export function parseIPv6(text: string): Result<bigint, IPv6ErrorCode> {
  if (text === '') return fail('empty', 'Enter an IPv6 address.');
  if (text.startsWith('[')) return fail('bracketed', 'Remove the brackets (and any port): write 2001:db8::1, not [2001:db8::1]:443.');
  if (text.includes('%')) return fail('zone-id', 'Zone indexes such as %eth0 are not supported here. Remove the % and everything after it.');
  for (let i = 0; i < text.length; i++) {
    if (!/[0-9a-fA-F:.]/.test(text[i])) return fail('invalid-char', `Unexpected ${describeCharAt(text, i)}. IPv6 addresses use hex digits and colons.`, i);
  }
  if (!text.includes(':')) return fail('no-colon', 'An IPv6 address contains colons, such as 2001:db8::1.');

  let body = text;
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (text.slice(0, lastColon).includes('.')) return fail('ipv4-position', 'An embedded IPv4 address may only form the last 32 bits, as in ::ffff:192.0.2.1.');
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4.ok) return fail('ipv4-tail', `The embedded IPv4 address is not valid: ${v4.error.message}`);
    body = `${text.slice(0, lastColon + 1)}${(v4.value >> 16n).toString(16)}:${(v4.value & 0xffffn).toString(16)}`;
  }

  const halves = body.split('::');
  if (halves.length > 2) return fail('double-compression', "'::' may appear only once in an address.");
  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] === '' ? [] : halves[0].split(':');
    const tail = halves[1] === '' ? [] : halves[1].split(':');
    if ([...head, ...tail].some(g => g === '')) return fail('empty-group', "Two colons in a row mean '::', and a single colon cannot start or end the address. Check for a stray ':'.");
    if (head.length + tail.length > 7) return fail('group-count', `With '::' there can be at most 7 other groups (found ${head.length + tail.length}).`);
    groups = [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  } else {
    groups = body.split(':');
    if (groups[0] === '' || groups[groups.length - 1] === '') return fail('empty-group', "A single colon cannot start or end an address. Did you mean '::'?");
    if (groups.some(g => g === '')) return fail('empty-group', "Two colons in a row mean '::', and a single colon cannot start or end the address. Check for a stray ':'.");
    if (groups.length !== 8) return fail('group-count', `An IPv6 address has 8 groups (found ${groups.length}). Use '::' to stand for a run of zero groups.`);
  }
  let value = 0n;
  for (const g of groups) {
    if (!HEX.test(g)) return fail('group-too-long', `"${g}" is not a group of 1 to 4 hex digits.`);
    value = (value << 16n) | BigInt(`0x${g}`);
  }
  return ok(value);
}

export function ipv6Groups(value: bigint): number[] {
  if (value < 0n || value > IPV6_MAX) throw new RangeError(`Not an IPv6 value: ${value}`);
  const groups: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((value >> shift) & 0xffffn));
  return groups;
}

/** IPv4-mapped addresses, ::ffff:0:0/96 (RFC 4291 section 2.5.5.2). */
export function isIPv4Mapped(value: bigint): boolean {
  return value >> 32n === 0xffffn;
}

/**
 * RFC 5952 canonical text: lowercase, no leading zeros, the longest run of two or more zero groups
 * replaced by '::' (the first such run on a tie), and a single zero group never compressed.
 * IPv4-mapped addresses use mixed notation, as section 5 recommends: ::ffff:192.0.2.1.
 */
export function formatIPv6(value: bigint): string {
  const groups = ipv6Groups(value);
  if (isIPv4Mapped(value)) return `::ffff:${formatIPv4(value & 0xffffffffn)}`;
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map(g => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/** All eight groups, four lowercase hex digits each. */
export function expandIPv6(value: bigint): string {
  return ipv6Groups(value).map(g => g.toString(16).padStart(4, '0')).join(':');
}
