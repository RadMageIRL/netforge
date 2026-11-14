/**
 * The utility engines against the Python standard library (tests/fixtures/utils-oracle.json, made
 * by scripts/oracles/utils_oracle.py): codecs, base64, binascii, urllib.parse, hashlib, hmac, uuid
 * and sorted() are independent implementations of the same rules.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  base64Decode, base64Encode, findInvalidUtf8, hexDecode, hexEncode, percentDecode, percentEncode, utf8Decode, utf8Encode,
} from '../../src/core/codec/codec';
import { convert } from '../../src/core/codec/convert';
import { digest, digestText, hmac, type HashId, type HmacHashId, type Subtle } from '../../src/core/crypto/digest';
import { inspectUuid, uuidV4 } from '../../src/core/random/tokens';
import { DEFAULT_TRANSFORM, textStats, transformLines } from '../../src/core/textops/lines';

interface Oracle {
  utf8: { hex: string; valid: boolean; text?: string; start?: number }[];
  encodings: { text?: string; hex: string; hexUpper: string; base64: string; base64url: string; base64urlUnpadded: string; percent: string; percentPlus: string }[];
  base64Strict: { text: string; hex: string | null }[];
  percentDecode: { text: string; hex: string; plusHex: string }[];
  digests: ({ hex: string } & Record<HashId, { hex: string; base64: string }>)[];
  hmacs: ({ key: string; data: string } & Record<HmacHashId, string>)[];
  uuids: { text: string; rfcVariant: boolean; versionNibble: number; version: number | null; firstSixBytes: number; random: string; asV4: string }[];
  sorts: { lines: string[]; sorted: string[]; sortedDescending: string[]; deduped: string[] }[];
  folds: { lines: string[]; sorted: string[]; deduped: string[] }[];
  naturals: { lines: string[]; sorted: string[] }[];
  stats: { text: string; characters: number; utf8Bytes: number; utf16Units: number; lines: number; words: number; longestLine: number; uniqueLines: number; emptyLines: number }[];
}

const oracle = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'utils-oracle.json'), 'utf8')) as Oracle;
const subtle = webcrypto.subtle as unknown as Subtle;

function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`);
  return result.value;
}

const LF = String.fromCharCode(0x0a);

describe('UTF-8 validity against Python codecs', () => {
  it('has a useful mix of valid and invalid cases', () => {
    expect(oracle.utf8.length).toBeGreaterThan(500);
    expect(oracle.utf8.filter(c => c.valid).length).toBeGreaterThan(150);
    expect(oracle.utf8.filter(c => !c.valid).length).toBeGreaterThan(150);
  });

  it('accepts exactly the byte strings Python accepts, and decodes them to the same text', () => {
    const wrong: string[] = [];
    for (const c of oracle.utf8) {
      const bytes = bytesOf(c.hex);
      const decoded = utf8Decode(bytes);
      if (decoded.ok !== c.valid) wrong.push(`${c.hex}: validity`);
      else if (decoded.ok && decoded.value !== c.text) wrong.push(`${c.hex}: text`);
      else if (decoded.ok && hexEncode(unwrap(utf8Encode(decoded.value))) !== c.hex) wrong.push(`${c.hex}: round trip`);
    }
    expect(wrong).toEqual([]);
  });

  it('points at the same first invalid byte as Python', () => {
    const wrong: string[] = [];
    for (const c of oracle.utf8) {
      const at = findInvalidUtf8(bytesOf(c.hex));
      const want = c.valid ? -1 : c.start;
      if (at !== want) wrong.push(`${c.hex}: got ${at}, want ${want}`);
      const decoded = utf8Decode(bytesOf(c.hex));
      if (!decoded.ok && (decoded.error.code !== 'invalid-utf8' || decoded.error.offset !== c.start)) wrong.push(`${c.hex}: error offset`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('encodings against Python base64, binascii and urllib', () => {
  it('encodes every case the same way', () => {
    const wrong: string[] = [];
    for (const c of oracle.encodings) {
      const bytes = bytesOf(c.hex);
      const got = {
        hex: hexEncode(bytes), hexUpper: hexEncode(bytes, true), base64: base64Encode(bytes),
        base64url: base64Encode(bytes, { alphabet: 'url', pad: true }), base64urlUnpadded: base64Encode(bytes, { alphabet: 'url' }),
        percent: percentEncode(bytes), percentPlus: percentEncode(bytes, { spaceAsPlus: true }),
      };
      for (const key of Object.keys(got) as (keyof typeof got)[]) if (got[key] !== c[key]) wrong.push(`${c.hex}: ${key}`);
    }
    expect(wrong).toEqual([]);
    expect(oracle.encodings.length).toBeGreaterThan(150);
  });

  it('decodes every encoding back to the same bytes', () => {
    const wrong: string[] = [];
    for (const c of oracle.encodings) {
      const decoded = {
        hex: hexDecode(c.hex), hexUpper: hexDecode(c.hexUpper), base64: base64Decode(c.base64),
        base64url: base64Decode(c.base64url, { alphabet: 'url' }), base64urlUnpadded: base64Decode(c.base64urlUnpadded, { alphabet: 'url', padding: 'forbidden' }),
        percent: percentDecode(c.percent), percentPlus: percentDecode(c.percentPlus, { plusAsSpace: true }),
      };
      for (const [key, result] of Object.entries(decoded)) if (!result.ok || hexEncode(result.value) !== c.hex) wrong.push(`${c.hex}: ${key}`);
    }
    expect(wrong).toEqual([]);
  });

  it('converts text through every representation like Python does', () => {
    const cases = oracle.encodings.filter(c => c.text !== undefined);
    expect(cases.length).toBe(60);
    const wrong: string[] = [];
    for (const c of cases) {
      const text = c.text!;
      const pairs: [string, string][] = [
        [unwrapConvert(convert(text, 'text', 'hex')), c.hex], [unwrapConvert(convert(text, 'text', 'base64')), c.base64],
        [unwrapConvert(convert(text, 'text', 'base64url')), c.base64urlUnpadded], [unwrapConvert(convert(text, 'text', 'url')), c.percent],
        [unwrapConvert(convert(text, 'text', 'url', { plusAsSpace: true })), c.percentPlus],
        [unwrapConvert(convert(c.base64, 'base64', 'text')), text], [unwrapConvert(convert(c.percent, 'url', 'text')), text],
        [unwrapConvert(convert(c.hexUpper, 'hex', 'text')), text], [unwrapConvert(convert(c.base64url, 'base64url', 'text')), text],
      ];
      pairs.forEach(([got, want], i) => { if (got !== want) wrong.push(`${c.hex}: pair ${i}`); });
    }
    expect(wrong).toEqual([]);
  });

  it('strict Base64 accepts exactly the canonical encodings', () => {
    const wrong: string[] = [];
    for (const c of oracle.base64Strict) {
      const decoded = base64Decode(c.text);
      if (decoded.ok !== (c.hex !== null)) wrong.push(`${JSON.stringify(c.text)}: accepted ${decoded.ok}`);
      else if (decoded.ok && hexEncode(decoded.value) !== c.hex) wrong.push(`${JSON.stringify(c.text)}: bytes`);
    }
    expect(wrong).toEqual([]);
    expect(oracle.base64Strict.filter(c => c.hex === null).length).toBeGreaterThan(100);
    expect(oracle.base64Strict.filter(c => c.hex !== null).length).toBeGreaterThan(50);
  });

  it('percent-decodes mixed raw and escaped text to the same bytes, with and without plus as space', () => {
    const wrong: string[] = [];
    for (const c of oracle.percentDecode) {
      const plain = percentDecode(c.text);
      const plus = percentDecode(c.text, { plusAsSpace: true });
      if (!plain.ok || hexEncode(plain.value) !== c.hex) wrong.push(`${c.text}: plain`);
      if (!plus.ok || hexEncode(plus.value) !== c.plusHex) wrong.push(`${c.text}: plus`);
    }
    expect(wrong).toEqual([]);
    expect(oracle.percentDecode.length).toBe(100);
  });
});

function unwrapConvert(result: ReturnType<typeof convert>): string {
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`);
  return result.value.output;
}

describe('digests against Python hashlib and hmac', () => {
  it('MD5, SHA-1, SHA-256, SHA-384 and SHA-512 agree at every length, in hex and Base64', async () => {
    const wrong: string[] = [];
    for (const c of oracle.digests) {
      const data = bytesOf(c.hex);
      for (const id of ['MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const) {
        const got = digestText(await digest(subtle, id, data));
        if (got.hex !== c[id].hex || got.base64 !== c[id].base64) wrong.push(`${id} of ${data.length} bytes`);
      }
    }
    expect(wrong).toEqual([]);
    expect(oracle.digests.length).toBe(65);
  });

  it('HMAC-SHA256, 384 and 512 agree for keys shorter than, equal to and longer than a block', async () => {
    const wrong: string[] = [];
    for (const c of oracle.hmacs) {
      for (const id of ['SHA-256', 'SHA-384', 'SHA-512'] as const) {
        const got = hexEncode(await hmac(subtle, id, bytesOf(c.key), bytesOf(c.data)));
        if (got !== c[id]) wrong.push(`${id} with a ${c.key.length / 2}-byte key`);
      }
    }
    expect(wrong).toEqual([]);
    expect(oracle.hmacs.length).toBe(40);
  });
});

describe('UUIDs against Python uuid', () => {
  it('reads the same variant, version and leading 48 bits', () => {
    const wrong: string[] = [];
    for (const c of oracle.uuids) {
      const info = inspectUuid(c.text);
      if (!info) { wrong.push(`${c.text}: not read`); continue; }
      if (info.rfcVariant !== c.rfcVariant || info.version !== c.versionNibble) wrong.push(`${c.text}: variant or version`);
      if (c.version !== null && info.version !== c.version) wrong.push(`${c.text}: version`);
      const wantTime = c.rfcVariant && c.versionNibble === 7 ? c.firstSixBytes : null;
      if (info.timestampMs !== wantTime) wrong.push(`${c.text}: timestamp`);
    }
    expect(wrong).toEqual([]);
    expect(oracle.uuids.some(c => c.rfcVariant && c.versionNibble === 7)).toBe(true);
    expect(oracle.uuids.some(c => !c.rfcVariant)).toBe(true);
  });

  it('makes the version 4 UUID Python makes from the same 16 random bytes', () => {
    const wrong: string[] = [];
    for (const c of oracle.uuids) {
      const got = uuidV4(bytes => bytes.set(bytesOf(c.random)));
      if (got !== c.asV4) wrong.push(c.random);
    }
    expect(wrong).toEqual([]);
  });
});

describe('text operations against Python', () => {
  const run = (lines: string[], options: Partial<typeof DEFAULT_TRANSFORM>): string[] => {
    // Every line is terminated, so an empty last line is still a line.
    const result = transformLines(lines.map(l => l + LF).join(''), { ...DEFAULT_TRANSFORM, ...options });
    if (!result.ok) throw new Error(result.code);
    return result.output.split(LF).slice(0, -1);
  };

  it('sorts by code point like sorted(), ascending and descending, with astral and private-use characters', () => {
    const wrong: number[] = [];
    oracle.sorts.forEach((c, i) => {
      if (JSON.stringify(run(c.lines, { sort: 'text' })) !== JSON.stringify(c.sorted)) wrong.push(i);
      // Python's reverse sort keeps equal items in original order, as a stable descending sort does.
      if (JSON.stringify(run(c.lines, { sort: 'text', descending: true })) !== JSON.stringify(c.sortedDescending)) wrong.push(-i);
    });
    expect(wrong).toEqual([]);
    // The fixture really exercises the case where UTF-16 order and code point order disagree.
    const astral = String.fromCodePoint(0x10000);
    const privateUse = String.fromCharCode(0xe000);
    expect(oracle.sorts.some(c => c.lines.some(l => l.startsWith(privateUse)) && c.lines.some(l => l.codePointAt(0)! >= 0x10000))).toBe(true);
    expect(astral < privateUse).toBe(true);
    expect(run([astral, privateUse], { sort: 'text' })).toEqual([privateUse, astral]);
  });

  it('removes duplicates keeping the first, like dict.fromkeys', () => {
    const wrong: number[] = [];
    oracle.sorts.forEach((c, i) => {
      if (JSON.stringify(run(c.lines, { dedupe: true })) !== JSON.stringify(c.deduped)) wrong.push(i);
    });
    expect(wrong).toEqual([]);
  });

  it('sorts and removes duplicates ignoring case like key=str.lower', () => {
    const wrong: number[] = [];
    oracle.folds.forEach((c, i) => {
      if (JSON.stringify(run(c.lines, { sort: 'text', ignoreCase: true })) !== JSON.stringify(c.sorted)) wrong.push(i);
      if (JSON.stringify(run(c.lines, { dedupe: true, ignoreCase: true })) !== JSON.stringify(c.deduped)) wrong.push(-i - 1);
    });
    expect(wrong).toEqual([]);
    expect(oracle.folds.length).toBe(40);
  });

  it('sorts in natural order like a (letters, value, digit count, letters) key', () => {
    const wrong: number[] = [];
    oracle.naturals.forEach((c, i) => {
      if (JSON.stringify(run(c.lines, { sort: 'natural' })) !== JSON.stringify(c.sorted)) wrong.push(i);
    });
    expect(wrong).toEqual([]);
    expect(oracle.naturals.length).toBe(40);
  });

  it('counts characters, bytes, lines and words like Python', () => {
    const wrong: string[] = [];
    oracle.stats.forEach((c, i) => {
      const s = textStats(c.text);
      for (const key of ['characters', 'utf8Bytes', 'utf16Units', 'lines', 'words', 'longestLine', 'uniqueLines', 'emptyLines'] as const) {
        if (s[key] !== c[key]) wrong.push(`${i}: ${key} got ${s[key]}, want ${c[key]}`);
      }
    });
    expect(wrong).toEqual([]);
    expect(oracle.stats.length).toBe(60);
  });
});
