// Builds src/core/net/registry-data.ts from the IANA registry files in data/iana/.
//
//   node scripts/registry/build-registry.mjs           write the module
//   node scripts/registry/build-registry.mjs --check   exit 1 if the module is out of date
//
// Sources (retrieved 2026-11-14, see data/iana/SOURCES.txt):
//   https://www.iana.org/assignments/iana-ipv4-special-registry/  (CSV and XML)
//   https://www.iana.org/assignments/iana-ipv6-special-registry/  (CSV and XML)
//   https://www.iana.org/assignments/ipv6-address-space/          (CSV)
// The CSVs hold the rows; the XML files hold the footnote text and the registry's update date.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const DATA = join(ROOT, 'data', 'iana');
const OUT = join(ROOT, 'src', 'core', 'net', 'registry-data.ts');
const RETRIEVED = '2026-11-14';

// Property tags for every special-purpose block, reviewed by hand against each block's RFC.
// A registry update that adds a block fails the build until the block is tagged here.
const TAGS = {
  '0.0.0.0/8': ['this-network'],
  '0.0.0.0/32': ['unspecified'],
  '10.0.0.0/8': ['private-use'],
  '100.64.0.0/10': ['shared-address-space'],
  '127.0.0.0/8': ['loopback'],
  '169.254.0.0/16': ['link-local'],
  '172.16.0.0/12': ['private-use'],
  '192.0.0.0/24': ['protocol-assignment'],
  '192.0.0.0/29': ['protocol-assignment'],
  '192.0.0.8/32': ['protocol-assignment'],
  '192.0.0.9/32': ['protocol-assignment', 'anycast'],
  '192.0.0.10/32': ['protocol-assignment', 'anycast'],
  '192.0.0.170/32': ['protocol-assignment'],
  '192.0.0.171/32': ['protocol-assignment'],
  '192.0.2.0/24': ['documentation'],
  '192.31.196.0/24': ['anycast'],
  '192.52.193.0/24': ['protocol-assignment'],
  '192.88.99.0/24': ['deprecated'],
  '192.88.99.2/32': ['anycast'],
  '192.168.0.0/16': ['private-use'],
  '192.175.48.0/24': ['anycast'],
  '198.18.0.0/15': ['benchmarking'],
  '198.51.100.0/24': ['documentation'],
  '203.0.113.0/24': ['documentation'],
  '240.0.0.0/4': ['reserved'],
  '255.255.255.255/32': ['limited-broadcast'],
  '::1/128': ['loopback'],
  '::/128': ['unspecified'],
  '::ffff:0:0/96': ['ipv4-mapped'],
  '64:ff9b::/96': ['translation'],
  '64:ff9b:1::/48': ['translation', 'private-use'],
  '100::/64': ['discard'],
  '100:0:0:1::/64': ['protocol-assignment'],
  '2001::/23': ['protocol-assignment'],
  '2001::/32': ['tunneling'],
  '2001:1::1/128': ['anycast'],
  '2001:1::2/128': ['anycast'],
  '2001:1::3/128': ['anycast'],
  '2001:2::/48': ['benchmarking'],
  '2001:3::/32': ['protocol-assignment'],
  '2001:4:112::/48': ['anycast'],
  '2001:10::/28': ['deprecated'],
  '2001:20::/28': ['protocol-assignment'],
  '2001:30::/28': ['protocol-assignment'],
  '2001:db8::/32': ['documentation'],
  '2002::/16': ['tunneling'],
  '2620:4f:8000::/48': ['anycast'],
  '3fff::/20': ['documentation'],
  '5f00::/16': ['protocol-assignment'],
  'fc00::/7': ['private-use'],
  'fe80::/10': ['link-local'],
};

/** RFC 4180 CSV, including quoted fields with doubled quotes, commas and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(f => f !== '')) rows.push(row); }
  return rows;
}

function readXml(name) {
  const xml = readFileSync(join(DATA, name), 'utf8');
  const updated = /<updated>([^<]+)<\/updated>/.exec(xml)[1];
  const footnotes = {};
  for (const m of xml.matchAll(/<footnote anchor="(\d+)">([\s\S]*?)<\/footnote>/g)) {
    const text = m[2]
      .replace(/<xref type="rfc" data="rfc(\d+)"(?: section="([^"]+)")?[^>]*\/>/g, (_x, n, s) => (s ? `RFC ${n}, Section ${s}` : `RFC ${n}`))
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    footnotes[m[1]] = text;
  }
  return { updated, footnotes };
}

function flag(cell, footnotes, notes) {
  const m = /^\s*(True|False|N\/A)?\s*(?:\[(\d+)\])?\s*$/.exec(cell);
  if (!m) throw new Error(`Unexpected flag cell: ${JSON.stringify(cell)}`);
  if (m[2]) notes.add(footnotes[m[2]] ?? (() => { throw new Error(`Missing footnote ${m[2]}`); })());
  if (!m[1]) return 'unspecified';
  return m[1] === 'True' ? 'true' : m[1] === 'False' ? 'false' : 'n/a';
}

function specialRows(family, csvName, xmlName) {
  const { updated, footnotes } = readXml(xmlName);
  const [header, ...rows] = parseCsv(readFileSync(join(DATA, csvName), 'utf8'));
  if (header.join('|') !== 'Address Block|Name|RFC|Allocation Date|Termination Date|Source|Destination|Forwardable|Globally Reachable|Reserved-by-Protocol') {
    throw new Error(`${csvName}: unexpected columns ${header.join('|')}`);
  }
  const out = [];
  for (const [blockCell, name, rfc, allocated, terminated, ...flags] of rows) {
    const notes = new Set();
    const blockNote = /\[(\d+)\]/.exec(blockCell);
    if (blockNote) notes.add(footnotes[blockNote[1]]);
    const values = flags.map(f => flag(f, footnotes, notes));
    for (const block of blockCell.replace(/\[\d+\]/g, '').split(',').map(b => b.trim()).filter(Boolean)) {
      const tags = TAGS[block];
      if (!tags) throw new Error(`No property tags for ${block} (${name}). Review it and add it to TAGS.`);
      out.push({
        family, block, name: name.replace(/^"(.*)"$/, '$1'), rfc: rfc.replace(/[[\]]/g, ''), allocated,
        terminated: terminated === 'N/A' || terminated === '' ? null : terminated,
        source: values[0], destination: values[1], forwardable: values[2], globallyReachable: values[3], reservedByProtocol: values[4],
        notes: [...notes], tags,
      });
    }
  }
  return { updated, rows: out };
}

function addressSpaceRows() {
  const [header, ...rows] = parseCsv(readFileSync(join(DATA, 'ipv6-address-space-1.csv'), 'utf8'));
  if (header.join('|') !== 'IPv6 Prefix|Allocation|Reference|Notes') throw new Error(`ipv6-address-space: unexpected columns ${header.join('|')}`);
  return rows.map(([block, allocation, reference, notes]) => ({
    block, allocation, reference: reference.replace(/[[\]]/g, ''), notes: notes.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim(),
  }));
}

const v4 = specialRows(4, 'iana-ipv4-special-registry-1.csv', 'iana-ipv4-special-registry.xml');
const v6 = specialRows(6, 'iana-ipv6-special-registry-1.csv', 'iana-ipv6-special-registry.xml');
const space = addressSpaceRows();
const tagged = new Set([...v4.rows, ...v6.rows].map(r => r.block));
const unused = Object.keys(TAGS).filter(b => !tagged.has(b));
if (unused.length) throw new Error(`TAGS lists blocks the registry no longer has: ${unused.join(', ')}`);

const lines = [
  '// Generated by scripts/registry/build-registry.mjs from the IANA registry files in data/iana/.',
  '// Do not edit by hand: change the script or the source files, then run it again.',
  '',
  "import type { RegistryFlag, RegistryRow, AddressSpaceRow } from './registry-types';",
  '',
  'export const REGISTRY_SOURCES = {',
  `  ipv4Special: { url: 'https://www.iana.org/assignments/iana-ipv4-special-registry/', updated: '${v4.updated}', retrieved: '${RETRIEVED}' },`,
  `  ipv6Special: { url: 'https://www.iana.org/assignments/iana-ipv6-special-registry/', updated: '${v6.updated}', retrieved: '${RETRIEVED}' },`,
  `  ipv6AddressSpace: { url: 'https://www.iana.org/assignments/ipv6-address-space/', retrieved: '${RETRIEVED}' },`,
  '} as const;',
  '',
  'export const SPECIAL_PURPOSE: readonly RegistryRow[] = [',
  ...[...v4.rows, ...v6.rows].map(r => `  ${JSON.stringify(r)},`),
  '];',
  '',
  'export const IPV6_ADDRESS_SPACE: readonly AddressSpaceRow[] = [',
  ...space.map(r => `  ${JSON.stringify(r)},`),
  '];',
  '',
  'export type { RegistryFlag };',
  '',
];
const output = lines.join('\n');

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== output) {
    console.error('registry-data.ts is out of date: run node scripts/registry/build-registry.mjs');
    process.exit(1);
  }
  console.log(`registry-data.ts is up to date (${v4.rows.length} IPv4 and ${v6.rows.length} IPv6 special-purpose blocks, ${space.length} IPv6 address space rows).`);
} else {
  writeFileSync(OUT, output);
  console.log(`Wrote ${OUT}: ${v4.rows.length} IPv4 and ${v6.rows.length} IPv6 special-purpose blocks, ${space.length} IPv6 address space rows.`);
}
