/**
 * IPv4 address and subnet arithmetic. Addresses are unsigned 32-bit values held as bigint, so the
 * same integer-safe approach extends to 128-bit IPv6 without floating point or 32-bit shift
 * pitfalls (in JavaScript, `x << 32` on a number is `x << 0`).
 */
import { fail, ok, type Result } from '../result';

export const IPV4_BITS = 32;
export const IPV4_MAX = (1n << 32n) - 1n;

export type IPv4ErrorCode =
  | 'empty'
  | 'ipv6'
  | 'octet-count'
  | 'octet-empty'
  | 'octet-not-number'
  | 'leading-zero'
  | 'octet-range';

export type SubnetInputErrorCode =
  | IPv4ErrorCode
  | 'missing-prefix'
  | 'too-many-parts'
  | 'prefix-empty'
  | 'prefix-invalid'
  | 'prefix-range'
  | 'mask-invalid'
  | 'mask-noncontiguous'
  | 'wildcard-mask';

/** Parses a strict dotted-quad IPv4 address: four decimal numbers 0 to 255, no leading zeros. */
export function parseIPv4(text: string): Result<bigint, IPv4ErrorCode> {
  if (text === '') return fail('empty', 'Enter an IPv4 address.');
  if (text.includes(':')) return fail('ipv6', 'This looks like an IPv6 address, but IPv4 is expected here.');
  const parts = text.split('.');
  if (parts.length !== 4) {
    return fail('octet-count', `An IPv4 address has four numbers separated by dots (found ${parts.length}).`);
  }
  let value = 0n;
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part === '') return fail('octet-empty', `Part ${i + 1} of the address is empty.`);
    if (!/^[0-9]+$/.test(part)) return fail('octet-not-number', `"${part}" is not a number from 0 to 255.`);
    if (part.length > 1 && part.startsWith('0')) {
      return fail('leading-zero', `"${part}" has a leading zero. Some systems read leading zeros as octal, so they are not accepted.`);
    }
    if (part.length > 3 || Number(part) > 255) return fail('octet-range', `${part} is out of range: each part must be 0 to 255.`);
    value = (value << 8n) | BigInt(part);
  }
  return ok(value);
}

export function formatIPv4(value: bigint): string {
  if (value < 0n || value > IPV4_MAX) throw new RangeError(`Not an IPv4 value: ${value}`);
  return [24n, 16n, 8n, 0n].map(shift => ((value >> shift) & 255n).toString()).join('.');
}

export function prefixToMask(prefix: number): bigint {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > IPV4_BITS) throw new RangeError(`Invalid IPv4 prefix length: ${prefix}`);
  return (IPV4_MAX << BigInt(IPV4_BITS - prefix)) & IPV4_MAX;
}

/** The prefix length of a contiguous mask, or null when the mask's one bits are not contiguous. */
export function maskToPrefix(mask: bigint): number | null {
  let prefix = 0;
  while (prefix < IPV4_BITS && ((mask >> BigInt(IPV4_BITS - 1 - prefix)) & 1n) === 1n) prefix++;
  return prefixToMask(prefix) === mask ? prefix : null;
}

export interface SubnetInput {
  readonly address: bigint;
  readonly prefix: number;
  /** How the prefix was written: `/24` or as a dotted mask. */
  readonly notation: 'prefix' | 'mask';
}

/**
 * Parses calculator input: `192.0.2.10/24`, `192.0.2.10/255.255.255.0`, `192.0.2.10 255.255.255.0`
 * or `192.0.2.10 24`. Surrounding whitespace is ignored.
 */
export function parseSubnetInput(raw: string): Result<SubnetInput, SubnetInputErrorCode> {
  const text = raw.trim();
  if (text === '') return fail('empty', 'Enter an IPv4 address with a prefix length, such as 192.0.2.10/24.');
  let addressText: string;
  let suffix: string | null;
  const slash = text.indexOf('/');
  if (slash >= 0) {
    addressText = text.slice(0, slash).trim();
    suffix = text.slice(slash + 1).trim();
  } else {
    const parts = text.split(/[ \t]+/);
    if (parts.length > 2) return fail('too-many-parts', 'Enter one address followed by a prefix length or mask.');
    addressText = parts[0];
    suffix = parts.length === 2 ? parts[1] : null;
  }

  const address = parseIPv4(addressText);
  if (!address.ok) return address;
  if (suffix === null) return fail('missing-prefix', 'Add a prefix length (such as /24) or a subnet mask after the address.');
  if (suffix === '') return fail('prefix-empty', 'Enter a prefix length after the slash, from 0 to 32.');

  if (suffix.includes('.')) {
    const mask = parseIPv4(suffix);
    if (!mask.ok) return fail('mask-invalid', `The subnet mask is not valid: ${mask.error.message}`);
    const prefix = maskToPrefix(mask.value);
    if (prefix !== null) return ok({ address: address.value, prefix, notation: 'mask' });
    const inverse = ~mask.value & IPV4_MAX;
    const inversePrefix = maskToPrefix(inverse);
    if (inversePrefix !== null) {
      return fail('wildcard-mask', `${suffix} looks like a wildcard (inverse) mask. The matching subnet mask is ${formatIPv4(inverse)} (/${inversePrefix}).`);
    }
    return fail('mask-noncontiguous', `${suffix} is not a valid subnet mask: its one bits must be contiguous from the left.`);
  }

  if (!/^[0-9]+$/.test(suffix)) return fail('prefix-invalid', `"${suffix}" is not a prefix length. Use a number from 0 to 32.`);
  if (suffix.length > 2 || Number(suffix) > IPV4_BITS) return fail('prefix-range', `/${suffix} is out of range: an IPv4 prefix length is 0 to 32.`);
  return ok({ address: address.value, prefix: Number(suffix), notation: 'prefix' });
}

/**
 * - `standard`: prefix 0 to 30. The first address is the network address and the last is the
 *   broadcast address; neither is a usable host.
 * - `point-to-point`: /31 (RFC 3021). Both addresses are usable and there is no broadcast address.
 * - `host`: /32. A single address.
 */
export type SubnetKind = 'standard' | 'point-to-point' | 'host';

export interface SubnetInfo {
  readonly address: bigint;
  readonly prefix: number;
  readonly kind: SubnetKind;
  readonly network: bigint;
  /** Null for /31 and /32, which have no broadcast address. */
  readonly broadcast: bigint | null;
  readonly mask: bigint;
  readonly wildcard: bigint;
  readonly totalAddresses: bigint;
  readonly firstUsable: bigint;
  readonly lastUsable: bigint;
  readonly usableHosts: bigint;
  /** What the entered address is within its subnet. */
  readonly addressRole: 'network' | 'broadcast' | 'host';
}

export function calculateSubnet(address: bigint, prefix: number): SubnetInfo {
  if (address < 0n || address > IPV4_MAX) throw new RangeError(`Not an IPv4 value: ${address}`);
  const mask = prefixToMask(prefix);
  const wildcard = ~mask & IPV4_MAX;
  const network = address & mask;
  const last = network | wildcard;
  const totalAddresses = 1n << BigInt(IPV4_BITS - prefix);
  if (prefix === 32) {
    return { address, prefix, kind: 'host', network, broadcast: null, mask, wildcard, totalAddresses, firstUsable: network, lastUsable: network, usableHosts: 1n, addressRole: 'host' };
  }
  if (prefix === 31) {
    return { address, prefix, kind: 'point-to-point', network, broadcast: null, mask, wildcard, totalAddresses, firstUsable: network, lastUsable: last, usableHosts: 2n, addressRole: 'host' };
  }
  const addressRole = address === network ? 'network' : address === last ? 'broadcast' : 'host';
  return {
    address, prefix, kind: 'standard', network, broadcast: last, mask, wildcard, totalAddresses,
    firstUsable: network + 1n, lastUsable: last - 1n, usableHosts: totalAddresses - 2n, addressRole,
  };
}
