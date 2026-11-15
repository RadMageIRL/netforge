/**
 * Subnet Calculator settings links: the address and prefix in canonical form, and the split and
 * supernet lengths. The family follows from the address, so a link cannot name two families.
 */
import { FAMILY_BITS, parsePrefixText, type Family } from '../../core/net/address';
import { formatIPv4, parseSubnetInput } from '../../core/net/ipv4';
import { formatIPv6 } from '../../core/net/ipv6';
import { intIn, onlyKeys, type ShareOffer } from '../../app/share';

export interface SubnetShare {
  readonly family: Family;
  /** Canonical address/prefix, as the input will hold it. */
  readonly text: string;
  readonly length: number;
  readonly split: number | null;
  readonly supernet: number | null;
}

const KEYS = ['ip', 'split', 'super'] as const;
const IPV4_LINK = /^[0-9.]{7,15}\/[0-9]{1,2}$/;
const IPV6_LINK = /^[0-9A-Fa-f:.]{2,45}\/[0-9]{1,3}$/;

/** Canonical address and prefix for typed input, or null when it does not parse. */
export function canonicalSubnet(family: Family, text: string): { text: string; length: number } | null {
  if (family === 4) {
    const r = parseSubnetInput(text);
    return r.ok ? { text: `${formatIPv4(r.value.address)}/${r.value.prefix}`, length: r.value.prefix } : null;
  }
  const r = parsePrefixText(text, 6);
  return r.ok ? { text: `${formatIPv6(r.value.address)}/${r.value.prefix.length}`, length: r.value.prefix.length } : null;
}

export function subnetOffer(family: Family, text: string, split: number | null, supernet: number | null): ShareOffer {
  const c = text.trim() === '' ? null : canonicalSubnet(family, text);
  if (!c) return { ok: false, reason: 'Enter a valid address and prefix to put them in a link.' };
  const params: [string, string][] = [['ip', c.text]];
  const summary = [`Address and prefix: ${c.text} (IPv${family})`];
  if (split !== null && split > c.length && split <= FAMILY_BITS[family]) {
    params.push(['split', String(split)]);
    summary.push(`Split into /${split} subnets`);
  }
  if (supernet !== null && supernet < c.length && supernet >= 0) {
    params.push(['super', String(supernet)]);
    summary.push(`Supernet /${supernet}`);
  }
  return { ok: true, params, summary };
}

export function readSubnetShare(params: ReadonlyMap<string, string>): SubnetShare | null {
  if (!onlyKeys(params, KEYS)) return null;
  const ip = params.get('ip');
  if (ip === undefined) return null;
  const family: Family | null = IPV4_LINK.test(ip) ? 4 : IPV6_LINK.test(ip) && ip.includes(':') ? 6 : null;
  if (family === null) return null;
  const c = canonicalSubnet(family, ip);
  if (!c) return null;
  const bits = FAMILY_BITS[family];
  let split: number | null = null;
  let supernet: number | null = null;
  if (params.has('split')) {
    split = intIn(params.get('split'), c.length + 1, bits);
    if (split === null) return null;
  }
  if (params.has('super')) {
    supernet = intIn(params.get('super'), 0, c.length - 1);
    if (supernet === null) return null;
  }
  return { family, text: c.text, length: c.length, split, supernet };
}
