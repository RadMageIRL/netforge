/**
 * Line-oriented network lists, as pasted into the IP Range Analyzer and Route Summarization:
 * one CIDR, address or range per line, blank lines and # comments ignored. Every problem is
 * reported with its line number; good lines are still returned.
 */
import { detectFamily, parseAddress, parsePrefixText, prefixToRange, rangeAsPrefix, type Family, type IpPrefix, type IpRange } from './address';

export type ListEntryKind = 'prefix' | 'address' | 'range';

export interface ListEntry extends IpRange {
  /** 1-based line number in the input. */
  readonly line: number;
  /** The text as written, without comment or surrounding space. */
  readonly text: string;
  readonly kind: ListEntryKind;
  /** For CIDR input, the network (host bits cleared). */
  readonly prefix: IpPrefix | null;
  /** CIDR input with host bits set, normalized to its network. */
  readonly hostBitsSet: boolean;
}

export interface LineError {
  readonly line: number;
  readonly text: string;
  readonly message: string;
}

export interface ParsedList {
  readonly entries: ListEntry[];
  readonly errors: LineError[];
}

export function parseNetworkList(input: string, options: { allowRanges?: boolean } = {}): ParsedList {
  const allowRanges = options.allowRanges ?? true;
  const entries: ListEntry[] = [];
  const errors: LineError[] = [];
  input.split(/\r\n|\r|\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const hash = rawLine.indexOf('#');
    const text = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (text === '') return;
    const result = parseEntry(text, allowRanges);
    if ('message' in result) errors.push({ line, text, message: result.message });
    else entries.push({ ...result, line, text });
  });
  return { entries, errors };
}

export type EntryCore = Omit<ListEntry, 'line' | 'text'>;

/** One item: a CIDR, a single address, or (when allowed) a range "first - last". */
export function parseNetworkItem(text: string, allowRanges = true): EntryCore | { message: string } {
  return parseEntry(text.trim(), allowRanges);
}

function parseEntry(text: string, allowRanges: boolean): EntryCore | { message: string } {
  if (text === '') return { message: 'Enter a network, an address or a range.' };
  if (text.includes('-')) {
    if (!allowRanges) return { message: 'Ranges are not accepted here. Enter networks in CIDR notation or single addresses.' };
    const dash = text.indexOf('-');
    const a = text.slice(0, dash).trim();
    const b = text.slice(dash + 1).trim();
    if (a === '' || b === '') return { message: 'A range needs a first and a last address, as in 192.0.2.10 - 192.0.2.20.' };
    if (detectFamily(a) !== detectFamily(b)) return { message: 'Both ends of a range must be the same family (IPv4 or IPv6).' };
    const first = parseAddress(a);
    if (!first.ok) return { message: `First address: ${first.error.message}` };
    const last = parseAddress(b);
    if (!last.ok) return { message: `Last address: ${last.error.message}` };
    if (last.value.value < first.value.value) return { message: 'The range ends before it starts. Put the lower address first.' };
    const range: IpRange = { family: first.value.family, first: first.value.value, last: last.value.value };
    return { ...range, kind: 'range', prefix: rangeAsPrefix(range), hostBitsSet: false };
  }
  if (text.includes('/') || (detectFamily(text) === 4 && /[ \t]/.test(text))) {
    const p = parsePrefixText(text);
    if (!p.ok) return { message: p.error.message };
    return { ...prefixToRange(p.value.prefix), kind: 'prefix', prefix: p.value.prefix, hostBitsSet: p.value.hostBitsSet };
  }
  const address = parseAddress(text);
  if (!address.ok) return { message: address.error.message };
  const family: Family = address.value.family;
  const v = address.value.value;
  return { family, first: v, last: v, kind: 'address', prefix: { family, network: v, length: family === 4 ? 32 : 128 }, hostBitsSet: false };
}
