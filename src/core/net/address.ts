/**
 * Address-family-aware primitives shared by every network tool. An address, prefix or range
 * always carries its family; operations that need one family throw FamilyMismatchError when
 * handed both, so IPv4 and IPv6 can never be mixed by accident. All arithmetic is exact bigint.
 */
import { fail, ok, type Result } from '../result';
import { formatIPv4, IPV4_MAX, parseIPv4, parseSubnetInput, type IPv4ErrorCode, type SubnetInputErrorCode } from './ipv4';
import { expandIPv6, formatIPv6, IPV6_MAX, parseIPv6, type IPv6ErrorCode } from './ipv6';

export type Family = 4 | 6;

export const FAMILY_BITS: Readonly<Record<Family, number>> = { 4: 32, 6: 128 };

export function familyName(family: Family): string {
  return family === 4 ? 'IPv4' : 'IPv6';
}

export function familyMax(family: Family): bigint {
  return family === 4 ? IPV4_MAX : IPV6_MAX;
}

export interface IpAddress {
  readonly family: Family;
  readonly value: bigint;
}

/** An aligned CIDR block. `network` never has host bits set. */
export interface IpPrefix {
  readonly family: Family;
  readonly network: bigint;
  readonly length: number;
}

/** An inclusive address range, first <= last. */
export interface IpRange {
  readonly family: Family;
  readonly first: bigint;
  readonly last: bigint;
}

export class FamilyMismatchError extends Error {
  constructor(operation: string) {
    super(`${operation} needs addresses of one family, but was given both IPv4 and IPv6.`);
    this.name = 'FamilyMismatchError';
  }
}

/** Returns the shared family, or throws FamilyMismatchError. */
export function requireSameFamily(operation: string, items: readonly { readonly family: Family }[]): Family {
  if (items.length === 0) throw new RangeError(`${operation} needs at least one network.`);
  const family = items[0].family;
  for (const item of items) if (item.family !== family) throw new FamilyMismatchError(operation);
  return family;
}

/** A colon means IPv6; anything else is treated as IPv4. */
export function detectFamily(text: string): Family {
  return text.includes(':') ? 6 : 4;
}

export type AddressErrorCode = IPv4ErrorCode | IPv6ErrorCode | 'wrong-family';

export function parseAddress(text: string, family?: Family): Result<IpAddress, AddressErrorCode> {
  const detected = detectFamily(text);
  if (family !== undefined && family !== detected) {
    return fail('wrong-family', family === 4 ? `"${text}" is an IPv6 address, but IPv4 is expected here.` : `"${text}" is not an IPv6 address (IPv6 addresses contain colons).`);
  }
  const r = detected === 4 ? parseIPv4(text) : parseIPv6(text);
  return r.ok ? ok({ family: detected, value: r.value }) : r;
}

export function formatAddress(family: Family, value: bigint): string {
  return family === 4 ? formatIPv4(value) : formatIPv6(value);
}

/** The full-length form: IPv6 with all eight four-digit groups; IPv4 unchanged. */
export function expandAddress(family: Family, value: bigint): string {
  return family === 4 ? formatIPv4(value) : expandIPv6(value);
}

function checkLength(family: Family, length: number): void {
  if (!Number.isInteger(length) || length < 0 || length > FAMILY_BITS[family]) throw new RangeError(`Invalid ${familyName(family)} prefix length: ${length}`);
}

export function prefixMask(family: Family, length: number): bigint {
  checkLength(family, length);
  const bits = BigInt(FAMILY_BITS[family]);
  return (familyMax(family) << (bits - BigInt(length))) & familyMax(family);
}

export function hostMask(family: Family, length: number): bigint {
  return ~prefixMask(family, length) & familyMax(family);
}

/** The prefix of the given length that contains `address` (host bits cleared). */
export function makePrefix(family: Family, address: bigint, length: number): IpPrefix {
  if (address < 0n || address > familyMax(family)) throw new RangeError(`Not an ${familyName(family)} value: ${address}`);
  return { family, network: address & prefixMask(family, length), length };
}

export function prefixSize(family: Family, length: number): bigint {
  checkLength(family, length);
  return 1n << BigInt(FAMILY_BITS[family] - length);
}

export function prefixToRange(p: IpPrefix): IpRange {
  return { family: p.family, first: p.network, last: p.network | hostMask(p.family, p.length) };
}

export function rangeSize(r: IpRange): bigint {
  return r.last - r.first + 1n;
}

export function formatPrefix(p: IpPrefix): string {
  return `${formatAddress(p.family, p.network)}/${p.length}`;
}

/** The prefix that is exactly this range, or null when the range is not one aligned block. */
export function rangeAsPrefix(r: IpRange): IpPrefix | null {
  const size = rangeSize(r);
  if ((size & (size - 1n)) !== 0n) return null;
  const length = FAMILY_BITS[r.family] - (size.toString(2).length - 1);
  return (r.first & hostMask(r.family, length)) === 0n ? { family: r.family, network: r.first, length } : null;
}

/** CIDR text when the range is one block, otherwise "first - last". */
export function formatRange(r: IpRange): string {
  const p = rangeAsPrefix(r);
  return p ? formatPrefix(p) : `${formatAddress(r.family, r.first)} - ${formatAddress(r.family, r.last)}`;
}

export type PrefixErrorCode = SubnetInputErrorCode | IPv6ErrorCode | 'wrong-family';

export interface ParsedPrefix {
  /** The address as written, which may have host bits set. */
  readonly address: bigint;
  readonly prefix: IpPrefix;
  readonly hostBitsSet: boolean;
}

/**
 * Parses "address/length" for either family. IPv4 also accepts a dotted mask, as the Subnet
 * Calculator always has. `family` restricts the accepted family.
 */
export function parsePrefixText(raw: string, family?: Family): Result<ParsedPrefix, PrefixErrorCode> {
  const text = raw.trim();
  const detected = text === '' ? (family ?? 4) : detectFamily(text);
  if (family !== undefined && text !== '' && family !== detected) {
    return fail('wrong-family', family === 4 ? 'This is an IPv6 network, but IPv4 is expected here.' : 'This is an IPv4 network, but IPv6 is expected here.');
  }
  if (detected === 4) {
    const r = parseSubnetInput(text);
    if (!r.ok) return r;
    const prefix = makePrefix(4, r.value.address, r.value.prefix);
    return ok({ address: r.value.address, prefix, hostBitsSet: prefix.network !== r.value.address });
  }
  if (text === '') return fail('empty', 'Enter an IPv6 address with a prefix length, such as 2001:db8::/48.');
  const slash = text.indexOf('/');
  const addressText = (slash >= 0 ? text.slice(0, slash) : text).trim();
  const address = parseIPv6(addressText);
  if (!address.ok) return address;
  if (slash < 0) return fail('missing-prefix', 'Add a prefix length after the address, such as /64.');
  const suffix = text.slice(slash + 1).trim();
  if (suffix === '') return fail('prefix-empty', 'Enter a prefix length after the slash, from 0 to 128.');
  if (!/^[0-9]+$/.test(suffix)) return fail('prefix-invalid', `"${suffix}" is not a prefix length. Use a number from 0 to 128.`);
  if (suffix.length > 3 || Number(suffix) > 128) return fail('prefix-range', `/${suffix} is out of range: an IPv6 prefix length is 0 to 128.`);
  const prefix = makePrefix(6, address.value, Number(suffix));
  return ok({ address: address.value, prefix, hostBitsSet: prefix.network !== address.value });
}
