import { describe, expect, it } from 'vitest';
import {
  base64Decode, base64Encode, countReplacements, findInvalidUtf8, findLoneSurrogate, hexDecode, hexEncode, percentDecode, percentEncode,
  utf8Decode, utf8Encode,
} from '../../src/core/codec/codec';
import { convert, fromBytes, MAX_INPUT_CHARS, REPRESENTATIONS, toBytes, type Representation } from '../../src/core/codec/convert';
import { rng } from '../helpers';

const b = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from([...text].map(ch => ch.charCodeAt(0)));
const cp = (...points: number[]) => String.fromCodePoint(...points);
const unit = (code: number) => String.fromCharCode(code);

function value<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`);
  return result.value;
}

function error(result: { ok: boolean; error?: { code: string; offset?: number } }): [string, number | undefined] {
  if (result.ok || !result.error) throw new Error('expected a failure');
  return [result.error.code, result.error.offset];
}

const code = (result: { ok: boolean; error?: { code: string; offset?: number } }) => error(result)[0];

const EURO = cp(0x20ac);
const GRIN = cp(0x1f600);
const REPLACEMENT = cp(0xfffd);
const LF = unit(0x0a);
const TAB = unit(0x09);

describe('UTF-8 encoding', () => {
  it('encodes one, two, three and four byte characters', () => {
    expect([...value(utf8Encode('A'))]).toEqual([0x41]);
    expect([...value(utf8Encode(cp(0xe9)))]).toEqual([0xc3, 0xa9]);
    expect([...value(utf8Encode(EURO))]).toEqual([0xe2, 0x82, 0xac]);
    expect([...value(utf8Encode(GRIN))]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect([...value(utf8Encode(''))]).toEqual([]);
  });

  it('encodes the edges of each length', () => {
    expect([...value(utf8Encode(cp(0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff)))]).toEqual([
      0x7f, 0xc2, 0x80, 0xdf, 0xbf, 0xe0, 0xa0, 0x80, 0xef, 0xbf, 0xbf, 0xf0, 0x90, 0x80, 0x80, 0xf4, 0x8f, 0xbf, 0xbf,
    ]);
  });

  it('keeps combining sequences as separate code points and never normalizes', () => {
    const decomposed = `e${cp(0x301)}`;
    expect([...value(utf8Encode(decomposed))]).toEqual([0x65, 0xcc, 0x81]);
    expect(value(utf8Decode(b(0x65, 0xcc, 0x81)))).toBe(decomposed);
    expect(value(utf8Decode(b(0xc3, 0xa9)))).toBe(cp(0xe9));
  });

  it('refuses an unpaired surrogate and says where it is', () => {
    const high = unit(0xd83d);
    const low = unit(0xde00);
    expect(error(utf8Encode(`ab${high}`))).toEqual(['lone-surrogate', 2]);
    expect(error(utf8Encode(`${low}ab`))).toEqual(['lone-surrogate', 0]);
    expect(error(utf8Encode(`a${high}b`))).toEqual(['lone-surrogate', 1]);
    // Low then high is two unpaired halves; the first is reported.
    expect(error(utf8Encode(`x${low}${high}`))).toEqual(['lone-surrogate', 1]);
    expect(error(utf8Encode(`${high}${high}${low}`))).toEqual(['lone-surrogate', 0]);
    expect(utf8Encode(`a${high}${low}b`).ok).toBe(true);
  });

  it('replaces an unpaired surrogate with U+FFFD only when asked', () => {
    expect([...value(utf8Encode(`a${unit(0xd800)}b`, { replace: true }))]).toEqual([0x61, 0xef, 0xbf, 0xbd, 0x62]);
    expect(utf8Encode(`a${unit(0xd800)}b`, { replace: false }).ok).toBe(false);
  });

  it('finds lone surrogates', () => {
    expect(findLoneSurrogate('')).toBe(-1);
    expect(findLoneSurrogate(`plain ${GRIN}${GRIN}`)).toBe(-1);
    expect(findLoneSurrogate(`${GRIN}${unit(0xdc00)}`)).toBe(2);
    expect(findLoneSurrogate(unit(0xdbff))).toBe(0);
    expect(findLoneSurrogate(`${unit(0xd7ff)}${unit(0xe000)}`)).toBe(-1);
  });
});

describe('UTF-8 decoding', () => {
  it('decodes valid text of every sequence length', () => {
    expect(value(utf8Decode(b(0x41, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80)))).toBe(`A${cp(0xe9)}${EURO}${GRIN}`);
    expect(value(utf8Decode(b()))).toBe('');
    expect(value(utf8Decode(b(0x00)))).toBe(unit(0));
  });

  it('keeps a leading byte order mark as a character', () => {
    const text = value(utf8Decode(b(0xef, 0xbb, 0xbf, 0x41)));
    expect(text).toHaveLength(2);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(value(utf8Decode(b(0xef, 0xbb, 0xbf, 0x41), { replace: true })).charCodeAt(0)).toBe(0xfeff);
  });

  // [name, bytes, offset of the first invalid byte]
  const INVALID: [string, number[], number][] = [
    ['a stray continuation byte', [0x80], 0],
    ['a stray continuation byte after text', [0x41, 0xbf], 1],
    ['a continuation after a complete sequence', [0xc3, 0xa9, 0xa9], 2],
    ['an overlong two-byte form (C0)', [0xc0, 0x80], 0],
    ['an overlong two-byte form (C1)', [0xc1, 0xbf], 0],
    ['an overlong three-byte form', [0xe0, 0x80, 0x80], 0],
    ['an overlong three-byte form at its upper edge', [0xe0, 0x9f, 0xbf], 0],
    ['an overlong four-byte form', [0xf0, 0x80, 0x80, 0x80], 0],
    ['an overlong four-byte form at its upper edge', [0xf0, 0x8f, 0xbf, 0xbf], 0],
    ['the first surrogate (ED A0 80)', [0xed, 0xa0, 0x80], 0],
    ['the last surrogate (ED BF BF)', [0xed, 0xbf, 0xbf], 0],
    ['a surrogate pair written as two three-byte forms', [0x41, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80], 1],
    ['a code point above U+10FFFF (F4 90)', [0xf4, 0x90, 0x80, 0x80], 0],
    ['the lead byte F5', [0xf5, 0x80, 0x80, 0x80], 0],
    ['the lead byte F8', [0xf8, 0x88, 0x80, 0x80, 0x80], 0],
    ['the byte FE', [0xfe], 0],
    ['the byte FF', [0x41, 0x42, 0xff], 2],
    ['a two-byte sequence cut short', [0x41, 0xc3], 1],
    ['a three-byte sequence cut after one byte', [0xe2], 0],
    ['a three-byte sequence cut after two bytes', [0x41, 0xe2, 0x82], 1],
    ['a four-byte sequence cut after one byte', [0xf0], 0],
    ['a four-byte sequence cut after two bytes', [0xf0, 0x9f], 0],
    ['a four-byte sequence cut after three bytes', [0x41, 0x41, 0xf0, 0x9f, 0x98], 2],
    ['a lead byte followed by ASCII', [0xc3, 0x41], 0],
    ['a three-byte sequence with a bad second byte', [0xe2, 0x41, 0xac], 0],
    ['a three-byte sequence with a bad third byte', [0xe2, 0x82, 0x41], 0],
    ['a four-byte sequence with a bad fourth byte', [0xf0, 0x9f, 0x98, 0x41], 0],
    ['a lead byte followed by a lead byte', [0xc3, 0xc3, 0xa9], 0],
  ];

  it.each(INVALID)('refuses %s', (_name, bytes, offset) => {
    const data = Uint8Array.from(bytes);
    expect(findInvalidUtf8(data)).toBe(offset);
    expect(error(utf8Decode(data))).toEqual(['invalid-utf8', offset]);
  });

  it('accepts the sequences on the valid side of every boundary', () => {
    for (const bytes of [
      [0xc2, 0x80], [0xdf, 0xbf], [0xe0, 0xa0, 0x80], [0xed, 0x9f, 0xbf], [0xee, 0x80, 0x80], [0xef, 0xbf, 0xbf],
      [0xf0, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf], [0xe1, 0x80, 0x80], [0xec, 0xbf, 0xbf], [0xf1, 0x80, 0x80, 0x80], [0xf3, 0xbf, 0xbf, 0xbf],
    ]) {
      expect(findInvalidUtf8(Uint8Array.from(bytes))).toBe(-1);
      expect(utf8Decode(Uint8Array.from(bytes)).ok).toBe(true);
    }
  });

  it('checks every single byte and every two-byte pair against the rules', () => {
    for (let x = 0; x < 256; x++) {
      expect(findInvalidUtf8(b(x)) === -1).toBe(x < 0x80);
      for (let y = 0; y < 256; y++) {
        const valid = (x < 0x80 && y < 0x80) || (x >= 0xc2 && x <= 0xdf && y >= 0x80 && y <= 0xbf);
        const at = findInvalidUtf8(b(x, y));
        if ((at === -1) !== valid) throw new Error(`pair ${x.toString(16)} ${y.toString(16)}`);
        if (!valid && at !== (x < 0x80 ? 1 : 0)) throw new Error(`offset for ${x.toString(16)} ${y.toString(16)}`);
      }
    }
  });

  it('agrees with a fatal TextDecoder on random bytes', () => {
    const random = rng(41);
    const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let invalid = 0;
    for (let i = 0; i < 3000; i++) {
      const data = Uint8Array.from({ length: 1 + Math.floor(random() * 6) }, () => {
        const r = random();
        return r < 0.3 ? Math.floor(random() * 0x80) : r < 0.6 ? 0x80 + Math.floor(random() * 0x40) : 0xc0 + Math.floor(random() * 0x40);
      });
      let ok = true;
      try { strict.decode(data); } catch { ok = false; }
      if (!ok) invalid++;
      if ((findInvalidUtf8(data) === -1) !== ok) throw new Error(`disagree on ${hexEncode(data)}`);
    }
    expect(invalid).toBeGreaterThan(500);
    expect(invalid).toBeLessThan(2900);
  });

  it('replaces invalid bytes with U+FFFD only when asked, and counts only the inserted ones', () => {
    expect(value(utf8Decode(b(0x41, 0xff, 0x42), { replace: true }))).toBe(`A${REPLACEMENT}B`);
    expect(utf8Decode(b(0x41, 0xff, 0x42)).ok).toBe(false);
    expect(countReplacements(b(0x41, 0xff, 0x42))).toBe(1);
    // A genuine U+FFFD in the data is not a replacement.
    expect(countReplacements(b(0xef, 0xbf, 0xbd))).toBe(0);
    expect(value(utf8Decode(b(0xef, 0xbf, 0xbd)))).toBe(REPLACEMENT);
    expect(countReplacements(b(0xef, 0xbf, 0xbd, 0xff, 0xef, 0xbf, 0xbd, 0x80))).toBe(2);
    expect(countReplacements(b(0x41, 0x42))).toBe(0);
    expect(countReplacements(b())).toBe(0);
  });
});

describe('hexadecimal', () => {
  it('encodes in lower and upper case', () => {
    expect(hexEncode(b())).toBe('');
    expect(hexEncode(b(0x00, 0x0f, 0xa0, 0xff))).toBe('000fa0ff');
    expect(hexEncode(b(0x00, 0x0f, 0xa0, 0xff), true)).toBe('000FA0FF');
    expect(hexEncode(Uint8Array.from({ length: 256 }, (_, i) => i))).toBe(Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).join(''));
  });

  it('matches the RFC 4648 section 10 Base16 vectors', () => {
    for (const [text, hex] of [['', ''], ['f', '66'], ['fo', '666F'], ['foo', '666F6F'], ['foob', '666F6F62'], ['fooba', '666F6F6261'], ['foobar', '666F6F626172']]) {
      expect(hexEncode(ascii(text), true)).toBe(hex);
      expect([...value(hexDecode(hex))]).toEqual([...ascii(text)]);
      expect([...value(hexDecode(hex.toLowerCase()))]).toEqual([...ascii(text)]);
    }
  });

  it('decodes mixed case', () => {
    expect([...value(hexDecode('DeadBEEF'))]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([...value(hexDecode(''))]).toEqual([]);
  });

  it('refuses an odd number of digits', () => {
    expect(error(hexDecode('abc'))).toEqual(['hex-odd-length', 3]);
    expect(error(hexDecode('a'))).toEqual(['hex-odd-length', 1]);
    expect(code(hexDecode('a b c', { lenient: true }))).toBe('hex-odd-length');
  });

  it('refuses anything that is not a hex digit, with its position', () => {
    expect(error(hexDecode('zz'))).toEqual(['hex-character', 0]);
    expect(error(hexDecode('12g4'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('12/4'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('12:4'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('12@4'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('12`4'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('12G4'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode(`12${cp(0xff11)}4`))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('0x12'))).toEqual(['hex-character', 1]);
  });

  it('refuses whitespace and separators in strict mode', () => {
    expect(error(hexDecode('de ad'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode(`dead${LF}`))).toEqual(['hex-character', 4]);
    expect(error(hexDecode('de:ad'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('de-ad'))).toEqual(['hex-character', 2]);
    expect(error(hexDecode(' dead'))).toEqual(['hex-character', 0]);
  });

  it('ignores whitespace, separators and 0x prefixes in lenient mode only', () => {
    const lenient = { lenient: true };
    expect([...value(hexDecode(`de:ad-be,ef 0x01${LF}0XFF${TAB}7f`, lenient))]).toEqual([0xde, 0xad, 0xbe, 0xef, 0x01, 0xff, 0x7f]);
    expect([...value(hexDecode('0xdeadbeef', lenient))]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([...value(hexDecode('d e a d', lenient))]).toEqual([0xde, 0xad]);
    expect([...value(hexDecode('   ', lenient))]).toEqual([]);
    // 0x is a prefix only at the start of a group, and other characters are still errors.
    expect(error(hexDecode('a0x1', lenient))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('0x0x12', lenient))).toEqual(['hex-character', 3]);
    expect(error(hexDecode('de;ad', lenient))).toEqual(['hex-character', 2]);
    expect(error(hexDecode('de_ad', lenient))).toEqual(['hex-character', 2]);
  });
});

describe('Base64 encoding', () => {
  const VECTORS: [string, string][] = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']];

  it('matches the RFC 4648 section 10 vectors in the standard alphabet', () => {
    for (const [text, encoded] of VECTORS) {
      expect(base64Encode(ascii(text))).toBe(encoded);
      expect([...value(base64Decode(encoded))]).toEqual([...ascii(text)]);
    }
  });

  it('matches the RFC 4648 vectors in the URL alphabet, padded and unpadded', () => {
    for (const [text, encoded] of VECTORS) {
      expect(base64Encode(ascii(text), { alphabet: 'url', pad: true })).toBe(encoded);
      expect(base64Encode(ascii(text), { alphabet: 'url' })).toBe(encoded.replace(/=/g, ''));
      expect([...value(base64Decode(encoded, { alphabet: 'url' }))]).toEqual([...ascii(text)]);
      expect([...value(base64Decode(encoded.replace(/=/g, ''), { alphabet: 'url' }))]).toEqual([...ascii(text)]);
      expect([...value(base64Decode(encoded.replace(/=/g, ''), { alphabet: 'url', padding: 'forbidden' }))]).toEqual([...ascii(text)]);
    }
  });

  it('uses + and / in the standard alphabet and - and _ in the URL alphabet', () => {
    const data = b(0xfb, 0xff, 0xbf);
    expect(base64Encode(data)).toBe('+/+/');
    expect(base64Encode(data, { alphabet: 'url' })).toBe('-_-_');
    expect(base64Encode(b(0xfb, 0xff))).toBe('+/8=');
    expect(base64Encode(b(0xfb, 0xff), { alphabet: 'url' })).toBe('-_8');
    expect(base64Encode(b(0xfb, 0xff), { pad: false })).toBe('+/8');
    expect([...value(base64Decode('-_-_', { alphabet: 'url' }))]).toEqual([0xfb, 0xff, 0xbf]);
  });

  it('pads by default only for the standard alphabet', () => {
    expect(base64Encode(b(1))).toBe('AQ==');
    expect(base64Encode(b(1), { alphabet: 'standard' })).toBe('AQ==');
    expect(base64Encode(b(1), { alphabet: 'url' })).toBe('AQ');
    expect(base64Encode(b(1, 2), { pad: false })).toBe('AQI');
  });

  it('round-trips every byte value at every length up to 300', () => {
    const random = rng(7);
    for (let n = 0; n <= 300; n++) {
      const data = Uint8Array.from({ length: n }, () => Math.floor(random() * 256));
      for (const alphabet of ['standard', 'url'] as const) {
        const encoded = base64Encode(data, { alphabet });
        expect(encoded).toBe(Buffer.from(data).toString(alphabet === 'url' ? 'base64url' : 'base64'));
        expect(hexEncode(value(base64Decode(encoded, { alphabet })))).toBe(hexEncode(data));
      }
    }
  });
});

describe('Base64 decoding, strict', () => {
  it('refuses characters outside the alphabet, with their position', () => {
    expect(error(base64Decode('Zm9v!A=='))).toEqual(['base64-character', 4]);
    expect(error(base64Decode('Zm*v'))).toEqual(['base64-character', 2]);
    expect(error(base64Decode(`Zm9${cp(0xe9)}`))).toEqual(['base64-character', 3]);
    expect(error(base64Decode('Zm.v', { alphabet: 'url' }))).toEqual(['base64-character', 2]);
    // Characters next to the alphabet in ASCII are not part of it.
    for (const ch of ['@', '[', '`', '{', ':', '.', ',', '~']) expect(code(base64Decode(`Zm9${ch}`))).toBe('base64-character');
  });

  it('names the other alphabet when a character belongs to it', () => {
    expect(error(base64Decode('Zm-v'))).toEqual(['base64-alphabet', 2]);
    expect(error(base64Decode('Zm_v'))).toEqual(['base64-alphabet', 2]);
    expect(error(base64Decode('Zm+v', { alphabet: 'url' }))).toEqual(['base64-alphabet', 2]);
    expect(error(base64Decode('Zm/v', { alphabet: 'url' }))).toEqual(['base64-alphabet', 2]);
    expect(code(base64Decode('Zm-v', { lenient: true }))).toBe('base64-alphabet');
  });

  it('refuses a length that leaves a single 6-bit character over', () => {
    expect(error(base64Decode('Z'))).toEqual(['base64-length', 1]);
    expect(error(base64Decode('Zm9vY'))).toEqual(['base64-length', 5]);
    expect(code(base64Decode('Zm9vY', { alphabet: 'url' }))).toBe('base64-length');
    expect(code(base64Decode('Zm9vY', { lenient: true }))).toBe('base64-length');
    expect(code(base64Decode('Z==='))).toBe('base64-length');
  });

  it('requires padding in the standard alphabet', () => {
    expect(error(base64Decode('Zg'))).toEqual(['base64-padding', 2]);
    expect(error(base64Decode('Zm8'))).toEqual(['base64-padding', 3]);
    expect(base64Decode('Zg', { padding: 'optional' }).ok).toBe(true);
  });

  it('refuses too little, too much or misplaced padding', () => {
    expect(error(base64Decode('Zg='))).toEqual(['base64-padding', 2]);
    expect(error(base64Decode('Zg==='))).toEqual(['base64-padding', 2]);
    expect(error(base64Decode('Zm8=='))).toEqual(['base64-padding', 3]);
    expect(error(base64Decode('Zm9v='))).toEqual(['base64-padding', 4]);
    expect(error(base64Decode('Zm9v===='))).toEqual(['base64-padding', 4]);
    expect(error(base64Decode('='))).toEqual(['base64-padding', 0]);
    expect(error(base64Decode('Zg==Zg=='))).toEqual(['base64-padding', 2]);
    expect(error(base64Decode('Zm=9v'))).toEqual(['base64-padding', 2]);
    expect(error(base64Decode('=Zm9v'))).toEqual(['base64-padding', 0]);
    // The right number of "=" in the wrong place: the count alone would pass these.
    expect(error(base64Decode('Zm=8'))).toEqual(['base64-padding', 2]);
    expect(error(base64Decode('Z=g='))).toEqual(['base64-padding', 1]);
    expect(error(base64Decode('=Zg='))).toEqual(['base64-padding', 0]);
    expect(code(base64Decode('Zm=8', { alphabet: 'url' }))).toBe('base64-padding');
    expect(code(base64Decode('Zm=8', { lenient: true }))).toBe('base64-padding');
    expect(code(base64Decode('Zg=', { alphabet: 'url' }))).toBe('base64-padding');
    expect(code(base64Decode('Zg==Zg', { lenient: true }))).toBe('base64-padding');
  });

  it('refuses any padding when padding is forbidden', () => {
    expect(error(base64Decode('Zg==', { alphabet: 'url', padding: 'forbidden' }))).toEqual(['base64-padding', 2]);
    expect(error(base64Decode('Zm8=', { alphabet: 'url', padding: 'forbidden' }))).toEqual(['base64-padding', 3]);
    expect(base64Decode('Zg', { alphabet: 'url', padding: 'forbidden' }).ok).toBe(true);
    expect(base64Decode('Zm9v', { alphabet: 'url', padding: 'forbidden' }).ok).toBe(true);
  });

  it('refuses a last character with bits that belong to no byte', () => {
    // "Zg==" is 'f'; "Zh==" has the same byte plus a stray bit.
    expect(error(base64Decode('Zh=='))).toEqual(['base64-trailing-bits', 4]);
    expect(code(base64Decode('Zm9='))).toBe('base64-trailing-bits');
    expect(code(base64Decode('Zh', { alphabet: 'url' }))).toBe('base64-trailing-bits');
    expect(code(base64Decode('Zm9', { alphabet: 'url', padding: 'forbidden' }))).toBe('base64-trailing-bits');
    // Every two-character tail: exactly the 4 canonical last characters out of 64 are accepted.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    expect([...alphabet].filter(ch => base64Decode(`A${ch}==`).ok).join('')).toBe('AQgw');
    expect([...alphabet].filter(ch => base64Decode(`AA${ch}=`).ok)).toHaveLength(16);
  });

  it('refuses whitespace', () => {
    expect(error(base64Decode('Zm9v Zm9v'))).toEqual(['base64-character', 4]);
    expect(error(base64Decode(`Zm9v${LF}`))).toEqual(['base64-character', 4]);
    expect(error(base64Decode(' Zm9v'))).toEqual(['base64-character', 0]);
    expect(code(base64Decode(`Zm9v${unit(0x0d)}${LF}Zm9v`))).toBe('base64-character');
  });
});

describe('Base64 decoding, lenient', () => {
  const lenient = { lenient: true };

  it('ignores ASCII whitespace', () => {
    expect([...value(base64Decode(` Zm9v${unit(0x0d)}${LF}YmFy${TAB}`, lenient))]).toEqual([...ascii('foobar')]);
    expect([...value(base64Decode(`Zg =${LF}=`, lenient))]).toEqual([0x66]);
  });

  it('does not ignore other whitespace', () => {
    expect(code(base64Decode(`Zm9v${cp(0xa0)}`, lenient))).toBe('base64-character');
    expect(code(base64Decode(`Zm9v${unit(0x0b)}`, lenient))).toBe('base64-character');
  });

  it('accepts missing padding and stray trailing bits', () => {
    expect([...value(base64Decode('Zg', lenient))]).toEqual([0x66]);
    expect([...value(base64Decode('Zm8', lenient))]).toEqual([0x66, 0x6f]);
    expect([...value(base64Decode('Zh==', lenient))]).toEqual([0x66]);
    expect([...value(base64Decode('Zh', lenient))]).toEqual([0x66]);
  });

  it('still refuses wrong padding, bad characters and impossible lengths', () => {
    expect(code(base64Decode('Zg=', lenient))).toBe('base64-padding');
    expect(code(base64Decode('Zm9v=', lenient))).toBe('base64-padding');
    expect(code(base64Decode('Zm9v!', lenient))).toBe('base64-character');
    expect(code(base64Decode('Z', lenient))).toBe('base64-length');
  });
});

describe('percent-encoding', () => {
  it('leaves exactly the RFC 3986 unreserved characters alone', () => {
    const unreserved = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    for (let i = 0; i < 256; i++) {
      const encoded = percentEncode(b(i));
      if (unreserved.includes(String.fromCharCode(i)) && i < 128) expect(encoded).toBe(String.fromCharCode(i));
      else expect(encoded).toBe(`%${i.toString(16).toUpperCase().padStart(2, '0')}`);
    }
  });

  it('encodes reserved characters that encodeURIComponent would leave', () => {
    expect(percentEncode(ascii("!'()*"))).toBe('%21%27%28%29%2A');
    expect(percentEncode(ascii('a b&c=d/e?f#g+h%'))).toBe('a%20b%26c%3Dd%2Fe%3Ff%23g%2Bh%25');
  });

  it('encodes non-ASCII text as its UTF-8 bytes', () => {
    expect(percentEncode(value(utf8Encode(`${EURO}${GRIN}`)))).toBe('%E2%82%AC%F0%9F%98%80');
  });

  it('writes a space as + only when asked, and always escapes a real plus', () => {
    expect(percentEncode(ascii('a b+c'))).toBe('a%20b%2Bc');
    expect(percentEncode(ascii('a b+c'), { spaceAsPlus: true })).toBe('a+b%2Bc');
  });

  it('decodes escapes in either case and keeps raw characters', () => {
    expect([...value(percentDecode('%e2%82%ac%E2%82%AC'))]).toEqual([0xe2, 0x82, 0xac, 0xe2, 0x82, 0xac]);
    expect([...value(percentDecode('a%00%ff~'))]).toEqual([0x61, 0x00, 0xff, 0x7e]);
    expect([...value(percentDecode(''))]).toEqual([]);
    expect([...value(percentDecode(`${EURO}%20${GRIN}`))]).toEqual([0xe2, 0x82, 0xac, 0x20, 0xf0, 0x9f, 0x98, 0x80]);
    expect([...value(percentDecode(`a&b=c/d${cp(0xe9)}`))]).toEqual([0x61, 0x26, 0x62, 0x3d, 0x63, 0x2f, 0x64, 0xc3, 0xa9]);
  });

  it('reads + as a plus sign unless asked to read it as a space', () => {
    expect([...value(percentDecode('a+b'))]).toEqual([0x61, 0x2b, 0x62]);
    expect([...value(percentDecode('a+b', { plusAsSpace: true }))]).toEqual([0x61, 0x20, 0x62]);
    expect([...value(percentDecode('a%2Bb', { plusAsSpace: true }))]).toEqual([0x61, 0x2b, 0x62]);
  });

  it('refuses an escape that is cut short', () => {
    expect(error(percentDecode('%'))).toEqual(['percent-incomplete', 0]);
    expect(error(percentDecode('%4'))).toEqual(['percent-incomplete', 0]);
    expect(error(percentDecode('ab%4'))).toEqual(['percent-incomplete', 2]);
    expect(error(percentDecode('100%'))).toEqual(['percent-incomplete', 3]);
    expect(percentDecode('%41').ok).toBe(true);
  });

  it('refuses an escape that is not two hex digits', () => {
    expect(error(percentDecode('%zz'))).toEqual(['percent-hex', 0]);
    expect(error(percentDecode('a%4gb'))).toEqual(['percent-hex', 1]);
    expect(error(percentDecode('a%g4b'))).toEqual(['percent-hex', 1]);
    expect(error(percentDecode('50% off'))).toEqual(['percent-hex', 2]);
    expect(error(percentDecode('%%41'))).toEqual(['percent-hex', 0]);
    expect(error(percentDecode('%+1', { plusAsSpace: true }))).toEqual(['percent-hex', 0]);
  });

  it('refuses an unpaired surrogate written raw', () => {
    expect(error(percentDecode(`a${unit(0xd800)}`))).toEqual(['lone-surrogate', 1]);
  });

  it('round-trips every byte', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(hexEncode(value(percentDecode(percentEncode(all))))).toBe(hexEncode(all));
    expect(hexEncode(value(percentDecode(percentEncode(all, { spaceAsPlus: true }), { plusAsSpace: true })))).toBe(hexEncode(all));
  });
});

describe('convert', () => {
  const REPS = REPRESENTATIONS.map(r => r.id);
  const out = (result: ReturnType<typeof convert>) => {
    if (!result.ok) throw new Error(`unexpected ${result.stage} failure: ${result.error.code}`);
    return result.value.output;
  };

  it('offers the five representations', () => {
    expect(REPS).toEqual(['text', 'base64', 'base64url', 'hex', 'url']);
  });

  it('converts text to every representation', () => {
    const text = `h${cp(0xe9)}llo ${EURO}?`;
    expect(out(convert(text, 'text', 'text'))).toBe(text);
    expect(out(convert(text, 'text', 'hex'))).toBe('68c3a96c6c6f20e282ac3f');
    expect(out(convert(text, 'text', 'hex', { upperHex: true }))).toBe('68C3A96C6C6F20E282AC3F');
    expect(out(convert(text, 'text', 'base64'))).toBe('aMOpbGxvIOKCrD8=');
    expect(out(convert(text, 'text', 'base64url'))).toBe('aMOpbGxvIOKCrD8');
    expect(out(convert(text, 'text', 'base64url', { pad: true }))).toBe('aMOpbGxvIOKCrD8=');
    expect(out(convert(text, 'text', 'base64', { pad: false }))).toBe('aMOpbGxvIOKCrD8');
    expect(out(convert(text, 'text', 'url'))).toBe('h%C3%A9llo%20%E2%82%AC%3F');
    expect(out(convert(text, 'text', 'url', { plusAsSpace: true }))).toBe('h%C3%A9llo+%E2%82%AC%3F');
  });

  it('goes from any representation to any other through the same bytes', () => {
    const random = rng(99);
    for (let round = 0; round < 40; round++) {
      // Valid UTF-8, so text can be one of the ends.
      const text = Array.from({ length: Math.floor(random() * 12) }, () => cp([0x41, 0x20, 0x2b, 0x25, 0xe9, 0x20ac, 0x1f600, 0x7e, 0x3d][Math.floor(random() * 9)])).join('');
      const bytes = value(utf8Encode(text));
      const forms = Object.fromEntries(REPS.map(rep => [rep, value(fromBytes(bytes, rep))])) as Record<Representation, string>;
      for (const from of REPS) {
        for (const to of REPS) {
          const result = convert(forms[from], from, to);
          if (!result.ok || result.value.output !== forms[to] || hexEncode(result.value.bytes) !== hexEncode(bytes)) throw new Error(`${from} to ${to} for ${JSON.stringify(text)}`);
        }
      }
    }
    expect(value(toBytes('', 'hex')).length).toBe(0);
  });

  it('reports the bytes it read and no replacements for an ordinary conversion', () => {
    const result = convert('aGk=', 'base64', 'text');
    expect(result.ok && [...result.value.bytes]).toEqual([0x68, 0x69]);
    expect(result.ok && result.value.output).toBe('hi');
    expect(result.ok && result.value.replaced).toBe(0);
  });

  it('says whether the input or the output is the problem', () => {
    const badInput = convert('Zh==', 'base64', 'text');
    expect(badInput.ok).toBe(false);
    expect(!badInput.ok && [badInput.stage, badInput.error.code, badInput.bytes]).toEqual(['input', 'base64-trailing-bits', null]);

    // The Base64 is fine; the bytes are not text. The bytes are handed back so they can be shown another way.
    const badOutput = convert('/w==', 'base64', 'text');
    expect(badOutput.ok).toBe(false);
    expect(!badOutput.ok && [badOutput.stage, badOutput.error.code, badOutput.error.offset]).toEqual(['output', 'invalid-utf8', 0]);
    expect(!badOutput.ok && badOutput.bytes && [...badOutput.bytes]).toEqual([0xff]);
    expect(out(convert('/w==', 'base64', 'hex'))).toBe('ff');
  });

  it('reports every input error code through its representation', () => {
    const cases: [string, Representation, string][] = [
      ['zz', 'hex', 'hex-character'], ['abc', 'hex', 'hex-odd-length'], ['Zm9v!', 'base64', 'base64-character'], ['Zm-v', 'base64', 'base64-alphabet'],
      ['Zm+v', 'base64url', 'base64-alphabet'], ['Z', 'base64', 'base64-length'], ['Zg', 'base64', 'base64-padding'], ['Zh==', 'base64', 'base64-trailing-bits'],
      ['%', 'url', 'percent-incomplete'], ['%zz', 'url', 'percent-hex'], [unit(0xd800), 'text', 'lone-surrogate'], [unit(0xdc00), 'url', 'lone-surrogate'],
    ];
    for (const [input, from, want] of cases) {
      const result = convert(input, from, 'hex');
      expect(!result.ok && [result.stage, result.error.code]).toEqual(['input', want]);
    }
  });

  it('applies the lenient option to Base64 and hex input only when it is on', () => {
    expect(convert(`Zm9v${LF}YmFy`, 'base64', 'text').ok).toBe(false);
    expect(out(convert(`Zm9v${LF}YmFy`, 'base64', 'text', { lenient: true }))).toBe('foobar');
    expect(out(convert('Zg', 'base64', 'text', { lenient: true }))).toBe('f');
    expect(convert('66 6f', 'hex', 'text').ok).toBe(false);
    expect(out(convert('66 6f', 'hex', 'text', { lenient: true }))).toBe('fo');
    expect(out(convert('Zm 8', 'base64url', 'text', { lenient: true }))).toBe('fo');
  });

  it('reads + as a space in URL input only when asked', () => {
    expect(out(convert('a+b%20c', 'url', 'text'))).toBe('a+b c');
    expect(out(convert('a+b%20c', 'url', 'text', { plusAsSpace: true }))).toBe('a b c');
  });

  it('never replaces invalid UTF-8 unless the replace option is on, and counts what it replaced', () => {
    expect(convert('41ff42fe', 'hex', 'text').ok).toBe(false);
    const replaced = convert('41ff42fe', 'hex', 'text', { replaceInvalid: true });
    expect(replaced.ok && [replaced.value.output, replaced.value.replaced]).toEqual([`A${REPLACEMENT}B${REPLACEMENT}`, 2]);
    // A genuine U+FFFD in the bytes is kept and not counted.
    const genuine = convert('efbfbd', 'hex', 'text', { replaceInvalid: true });
    expect(genuine.ok && [genuine.value.output, genuine.value.replaced]).toEqual([REPLACEMENT, 0]);
    // Valid input converts identically with the option on.
    const plain = convert('e282ac', 'hex', 'text', { replaceInvalid: true });
    expect(plain.ok && [plain.value.output, plain.value.replaced]).toEqual([EURO, 0]);
  });

  it('replaces unpaired surrogates in text input only with the replace option, and counts them', () => {
    const text = `a${unit(0xd800)}b${unit(0xdc00)}${GRIN}`;
    expect(convert(text, 'text', 'hex').ok).toBe(false);
    const replaced = convert(text, 'text', 'hex', { replaceInvalid: true });
    expect(replaced.ok && [replaced.value.output, replaced.value.replaced]).toEqual(['61efbfbd62efbfbdf09f9880', 2]);
  });

  it('refuses input over the size limit instead of cutting it', () => {
    expect(MAX_INPUT_CHARS).toBe(8_000_000);
    const atLimit = 'a'.repeat(MAX_INPUT_CHARS);
    const ok = convert(atLimit, 'hex', 'base64');
    expect(ok.ok && ok.value.bytes.length).toBe(MAX_INPUT_CHARS / 2);
    for (const from of REPS) {
      const result = convert(`${atLimit}a`, from, 'hex');
      expect(!result.ok && [result.stage, result.error.code, result.bytes]).toEqual(['input', 'too-large', null]);
    }
    expect(code(toBytes(`${atLimit}a`, 'text'))).toBe('too-large');
  });
});

describe('performance at the input limit', () => {
  // Generous bounds: these catch an accidental quadratic loop, not a slow machine.
  const LIMIT_MS = 6000;
  const timed = <T>(run: () => T): [T, number] => {
    const start = performance.now();
    const result = run();
    return [result, performance.now() - start];
  };

  it('Base64 encodes and decodes 8,000,000 characters', () => {
    const data = new Uint8Array(6_000_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;
    const [encoded, encodeMs] = timed(() => base64Encode(data));
    expect(encoded).toHaveLength(8_000_000);
    const [decoded, decodeMs] = timed(() => base64Decode(encoded));
    expect(decoded.ok && decoded.value.length).toBe(6_000_000);
    expect(decoded.ok && decoded.value[5_999_999]).toBe(data[5_999_999]);
    expect(encodeMs).toBeLessThan(LIMIT_MS);
    expect(decodeMs).toBeLessThan(LIMIT_MS);
  });

  it('hex encodes and decodes 8,000,000 characters', () => {
    const data = new Uint8Array(4_000_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13 + 5) & 0xff;
    const [encoded, encodeMs] = timed(() => hexEncode(data));
    expect(encoded).toHaveLength(8_000_000);
    const [decoded, decodeMs] = timed(() => hexDecode(encoded));
    expect(decoded.ok && decoded.value.length).toBe(4_000_000);
    expect(encodeMs).toBeLessThan(LIMIT_MS);
    expect(decodeMs).toBeLessThan(LIMIT_MS);
  });

  it('percent-decodes 8,000,000 characters and encodes them again', () => {
    const text = '%E2%82%ACab'.repeat(727_273).slice(0, 7_999_999);
    const [decoded, decodeMs] = timed(() => percentDecode(text.slice(0, text.lastIndexOf('%'))));
    expect(decoded.ok).toBe(true);
    const [encoded, encodeMs] = timed(() => percentEncode(value(decoded)));
    expect(encoded.length).toBeGreaterThan(7_000_000);
    expect(decodeMs).toBeLessThan(LIMIT_MS);
    expect(encodeMs).toBeLessThan(LIMIT_MS);
  });

  it('validates and decodes 8,000,000 bytes of UTF-8', () => {
    const data = value(utf8Encode(`ab${EURO}${GRIN}${cp(0xe9)}c`.repeat(700_000))).subarray(0, 8_000_000);
    const [bad, validateMs] = timed(() => findInvalidUtf8(data));
    // The cut may land inside a character; either way the scan covered the whole input.
    expect(bad === -1 || bad > 7_999_990).toBe(true);
    const [decoded, decodeMs] = timed(() => utf8Decode(data, { replace: true }));
    expect(decoded.ok && decoded.value.length).toBeGreaterThan(4_000_000);
    expect(validateMs).toBeLessThan(LIMIT_MS);
    expect(decodeMs).toBeLessThan(LIMIT_MS);
  });
});
