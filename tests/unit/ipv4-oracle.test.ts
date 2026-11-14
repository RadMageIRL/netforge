/** IPv4 results checked against Python's ipaddress (scripts/oracles/ipv4_oracle.py). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calculateSubnet, formatIPv4, parseIPv4, parseSubnetInput } from '../../src/core/net/ipv4';

interface SubnetCase {
  input: string; address: string; prefix: number; network: string; lastAddress: string; netmask: string; hostmask: string;
  numAddresses: string; firstHost: string; lastHost: string; hostCount: string;
}

const oracle = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'ipv4-oracle.json'), 'utf8')) as {
  source: string; subnets: SubnetCase[]; addresses: { text: string; valid: boolean }[];
};

describe('IPv4 against Python ipaddress', () => {
  it('has a meaningful number of cases, covering every prefix and both verdicts', () => {
    expect(oracle.subnets.length).toBeGreaterThan(300);
    expect(new Set(oracle.subnets.map(c => c.prefix)).size).toBe(33);
    expect(oracle.subnets.some(c => c.input.split('/')[1].includes('.'))).toBe(true);
    expect(oracle.addresses.filter(a => a.valid).length).toBeGreaterThan(200);
    expect(oracle.addresses.filter(a => !a.valid).length).toBeGreaterThan(2000);
  });

  it('matches every subnet property', () => {
    const mismatches: string[] = [];
    for (const c of oracle.subnets) {
      const parsed = parseSubnetInput(c.input);
      if (!parsed.ok) {
        mismatches.push(`${c.input}: rejected (${parsed.error.code})`);
        continue;
      }
      const s = calculateSubnet(parsed.value.address, parsed.value.prefix);
      const got = {
        address: formatIPv4(s.address), prefix: s.prefix, network: formatIPv4(s.network), netmask: formatIPv4(s.mask),
        hostmask: formatIPv4(s.wildcard), numAddresses: s.totalAddresses.toString(), firstHost: formatIPv4(s.firstUsable),
        lastHost: formatIPv4(s.lastUsable), hostCount: s.usableHosts.toString(),
        // NetForge reports no broadcast for /31 and /32; Python's broadcast_address is then the last address.
        lastAddress: s.broadcast === null ? formatIPv4(s.network | s.wildcard) : formatIPv4(s.broadcast),
      };
      const want = { address: c.address, prefix: c.prefix, network: c.network, netmask: c.netmask, hostmask: c.hostmask, numAddresses: c.numAddresses, firstHost: c.firstHost, lastHost: c.lastHost, hostCount: c.hostCount, lastAddress: c.lastAddress };
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${c.input}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      if ((s.broadcast === null) !== (c.prefix >= 31)) mismatches.push(`${c.input}: broadcast presence wrong for /${c.prefix}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('accepts and rejects exactly the address strings Python does', () => {
    const disagreements = oracle.addresses
      .filter(a => parseIPv4(a.text).ok !== a.valid)
      .map(a => `${JSON.stringify(a.text)}: python ${a.valid ? 'accepts' : 'rejects'}`);
    expect(disagreements).toEqual([]);
  });
});
