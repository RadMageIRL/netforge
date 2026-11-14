/** Number Bases & Bytes: integer parsing, fixed-width two's complement, byte order and storage units. */
import { describe, expect, it } from 'vitest';
import {
  bitsNeeded, checkWidth, convert, groupDigits, NUMBER_LIMITS, parseInteger, widthRange, withPrefix, type Base, type NumberOptions,
} from '../../src/core/numbers/bases';
import { convertAmount, exactDecimal, findUnit, parseAmount, reduce, roundedDecimal, UNIT_LIMITS, UNITS } from '../../src/core/numbers/units';

const u = (width: number | null, base: Base = 10): NumberOptions => ({ base, signed: false, width });
const s = (width: number | null, base: Base = 10): NumberOptions => ({ base, signed: true, width });

function value<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`unexpected error ${r.error.code}`);
  return r.value;
}
function code(r: { ok: true } | { ok: false; error: { code: string; offset?: number } }): string {
  return r.ok ? 'ok' : r.error.code;
}
function offset(r: { ok: true } | { ok: false; error: { code: string; offset?: number } }): number | undefined {
  return r.ok ? undefined : r.error.offset;
}

describe('parseInteger', () => {
  it('reads digits in each base', () => {
    expect(value(parseInteger('255', 10))).toEqual({ negative: false, magnitude: 255n, digits: 3 });
    expect(value(parseInteger('ff', 16)).magnitude).toBe(255n);
    expect(value(parseInteger('FF', 16)).magnitude).toBe(255n);
    expect(value(parseInteger('aBcDeF', 16)).magnitude).toBe(0xabcdefn);
    expect(value(parseInteger('11111111', 2)).magnitude).toBe(255n);
    expect(value(parseInteger('377', 8)).magnitude).toBe(255n);
    expect(value(parseInteger('0', 10)).magnitude).toBe(0n);
    expect(value(parseInteger('000123', 10)).magnitude).toBe(123n);
  });

  it('accepts a prefix that agrees with the base, in either case', () => {
    expect(value(parseInteger('0xff', 16)).magnitude).toBe(255n);
    expect(value(parseInteger('0XFF', 16)).magnitude).toBe(255n);
    expect(value(parseInteger('0b101', 2)).magnitude).toBe(5n);
    expect(value(parseInteger('0B101', 2)).magnitude).toBe(5n);
    expect(value(parseInteger('0o17', 8)).magnitude).toBe(15n);
    expect(value(parseInteger('0O17', 8)).magnitude).toBe(15n);
  });

  it('refuses a prefix for another base and says where', () => {
    for (const [text, base] of [['0xff', 10], ['0xff', 2], ['0xff', 8], ['0b11', 10], ['0b11', 8], ['0o7', 10], ['0o7', 2], ['0o7', 16]] as [string, Base][]) {
      const r = parseInteger(text, base);
      expect(code(r), `${text} in base ${base}`).toBe('prefix-mismatch');
      expect(offset(r)).toBe(0);
    }
    expect(offset(parseInteger('  -0x1', 10))).toBe(3);
  });

  it('reads 0b... in hexadecimal as hex digits, since b is a hex digit', () => {
    expect(value(parseInteger('0b1', 16)).magnitude).toBe(0xb1n);
    expect(value(parseInteger('0B', 16)).magnitude).toBe(0xbn);
  });

  it('takes a sign in decimal only', () => {
    expect(value(parseInteger('-12', 10))).toEqual({ negative: true, magnitude: 12n, digits: 2 });
    expect(value(parseInteger('+12', 10))).toEqual({ negative: false, magnitude: 12n, digits: 2 });
    expect(value(parseInteger('-0', 10)).negative).toBe(false);
    for (const base of [2, 8, 16] as Base[]) {
      expect(code(parseInteger('-1', base))).toBe('sign');
      expect(code(parseInteger('+1', base))).toBe('sign');
    }
    expect(offset(parseInteger(' -1', 16))).toBe(1);
  });

  it('allows single spaces and underscores between digits only', () => {
    expect(value(parseInteger('1_000_000', 10)).magnitude).toBe(1000000n);
    expect(value(parseInteger('1111 0000', 2))).toEqual({ negative: false, magnitude: 240n, digits: 8 });
    expect(value(parseInteger('0xdead_beef', 16)).magnitude).toBe(0xdeadbeefn);
    expect(value(parseInteger('  42\t\n', 10)).magnitude).toBe(42n);
    expect(code(parseInteger('1__0', 10))).toBe('separator');
    expect(offset(parseInteger('1__0', 10))).toBe(2);
    expect(code(parseInteger('1 _0', 10))).toBe('separator');
    expect(code(parseInteger('_10', 10))).toBe('separator');
    expect(offset(parseInteger('_10', 10))).toBe(0);
    expect(code(parseInteger('10_', 10))).toBe('separator');
    expect(offset(parseInteger('10_', 10))).toBe(2);
    expect(code(parseInteger('0x_ff', 16))).toBe('separator');
    expect(code(parseInteger('- 5', 10))).toBe('separator');
  });

  it('reports the first invalid digit with its position', () => {
    expect(code(parseInteger('12a', 10))).toBe('invalid-digit');
    expect(offset(parseInteger('12a', 10))).toBe(2);
    expect(offset(parseInteger('  102', 2))).toBe(4);
    expect(code(parseInteger('8', 8))).toBe('invalid-digit');
    expect(code(parseInteger('7', 8))).toBe('ok');
    expect(code(parseInteger('2', 2))).toBe('invalid-digit');
    expect(code(parseInteger('g', 16))).toBe('invalid-digit');
    expect(code(parseInteger('G', 16))).toBe('invalid-digit');
    expect(code(parseInteger('f', 16))).toBe('ok');
    expect(code(parseInteger('a', 10))).toBe('invalid-digit');
    expect(code(parseInteger('9', 10))).toBe('ok');
    expect(code(parseInteger('1.5', 10))).toBe('invalid-digit');
    expect(code(parseInteger('1e3', 10))).toBe('invalid-digit');
    expect(code(parseInteger('1,000', 10))).toBe('invalid-digit');
    expect(code(parseInteger('/', 10))).toBe('invalid-digit');
    expect(code(parseInteger(':', 10))).toBe('invalid-digit');
    expect(code(parseInteger('@', 16))).toBe('invalid-digit');
    expect(code(parseInteger('`', 16))).toBe('invalid-digit');
    expect(code(parseInteger(String.fromCharCode(0x661), 10))).toBe('invalid-digit');
  });

  it('refuses empty input, bare signs and prefixes, and input over the limit', () => {
    expect(code(parseInteger('', 10))).toBe('empty');
    expect(code(parseInteger('   ', 10))).toBe('empty');
    expect(code(parseInteger('-', 10))).toBe('no-digits');
    expect(code(parseInteger('0x', 16))).toBe('no-digits');
    expect(code(parseInteger('0b', 2))).toBe('no-digits');
    expect(code(parseInteger('1'.repeat(NUMBER_LIMITS.inputChars), 10))).toBe('ok');
    expect(code(parseInteger('1'.repeat(NUMBER_LIMITS.inputChars + 1), 10))).toBe('too-long');
  });
});

describe('widths and ranges', () => {
  it('accepts whole widths from 1 to 4096 only', () => {
    expect(code(checkWidth(1))).toBe('ok');
    expect(code(checkWidth(4096))).toBe('ok');
    for (const w of [0, -8, 4097, 1.5, NaN, Infinity]) expect(code(checkWidth(w)), String(w)).toBe('width');
    expect(code(convert('1', u(0)))).toBe('width');
    expect(code(convert('1', u(4097)))).toBe('width');
  });

  it('gives the range of each width', () => {
    expect(widthRange(8, false)).toEqual({ min: 0n, max: 255n });
    expect(widthRange(8, true)).toEqual({ min: -128n, max: 127n });
    expect(widthRange(1, false)).toEqual({ min: 0n, max: 1n });
    expect(widthRange(1, true)).toEqual({ min: -1n, max: 0n });
    expect(widthRange(64, false).max).toBe(18446744073709551615n);
    expect(widthRange(64, true)).toEqual({ min: -9223372036854775808n, max: 9223372036854775807n });
  });

  it('counts the bits a value needs', () => {
    expect([0n, 1n, 2n, 255n, 256n].map(v => bitsNeeded(v, false))).toEqual([1, 1, 2, 8, 9]);
    expect([0n, 1n, -1n, 127n, 128n, -128n, -129n].map(v => bitsNeeded(v, true))).toEqual([1, 2, 1, 8, 9, 8, 9]);
  });
});

describe('convert at a fixed width', () => {
  it('pads each base to the width', () => {
    const r = value(convert('10', u(16)));
    expect(r).toMatchObject({ binary: '0000000000001010', octal: '000012', hex: '000a', decimal: '10', value: 10n, pattern: 10n, width: 16, signed: false });
    expect(value(convert('5', u(7)))).toMatchObject({ binary: '0000101', octal: '005', hex: '05' });
    expect(value(convert('1', u(1)))).toMatchObject({ binary: '1', octal: '1', hex: '1' });
  });

  it('stores negative decimal values in two\'s complement', () => {
    expect(value(convert('-1', s(8)))).toMatchObject({ hex: 'ff', binary: '11111111', decimal: '-1', unsignedReading: 255n, signedReading: -1n, value: -1n });
    expect(value(convert('-128', s(8))).hex).toBe('80');
    expect(value(convert('-2', s(16))).hex).toBe('fffe');
    expect(value(convert('-9223372036854775808', s(64))).hex).toBe('8000000000000000');
    expect(value(convert('-1', s(128))).hex).toBe('f'.repeat(32));
  });

  it('enforces the range at both ends, signed and unsigned', () => {
    expect(code(convert('255', u(8)))).toBe('ok');
    expect(code(convert('256', u(8)))).toBe('overflow');
    expect(code(convert('127', s(8)))).toBe('ok');
    expect(code(convert('128', s(8)))).toBe('overflow');
    expect(code(convert('-128', s(8)))).toBe('ok');
    expect(code(convert('-129', s(8)))).toBe('overflow');
    expect(code(convert('18446744073709551615', u(64)))).toBe('ok');
    expect(code(convert('18446744073709551616', u(64)))).toBe('overflow');
    expect(code(convert('9223372036854775807', s(64)))).toBe('ok');
    expect(code(convert('9223372036854775808', s(64)))).toBe('overflow');
  });

  it('refuses a negative value as unsigned, but takes -0', () => {
    expect(code(convert('-1', u(8)))).toBe('negative-unsigned');
    expect(code(convert('-1', u(null)))).toBe('negative-unsigned');
    expect(code(convert('-300', u(8)))).toBe('negative-unsigned');
    expect(value(convert('-0', u(8))).decimal).toBe('0');
  });

  it('reads binary, octal and hex input as a bit pattern', () => {
    expect(value(convert('ff', u(8, 16))).decimal).toBe('255');
    const r = value(convert('ff', s(8, 16)));
    expect(r).toMatchObject({ decimal: '-1', value: -1n, unsignedReading: 255n, signedReading: -1n });
    expect(r.notes.join(' ')).toContain('bit pattern');
    expect(value(convert('7f', s(8, 16))).notes).toEqual([]);
    expect(value(convert('ff', u(8, 16))).notes).toEqual([]);
    expect(value(convert('-1', s(8))).notes).toEqual([]);
    expect(value(convert('80', s(8, 16))).decimal).toBe('-128');
    expect(value(convert('10000000', s(8, 2))).decimal).toBe('-128');
    expect(value(convert('200', s(8, 8))).decimal).toBe('-128');
    expect(value(convert('7f', s(8, 16))).decimal).toBe('127');
    expect(value(convert('ffff', s(32, 16))).decimal).toBe('65535');
  });

  it('refuses a bit pattern wider than the width, signed or not', () => {
    expect(code(convert('100', u(8, 16)))).toBe('overflow');
    expect(code(convert('100', s(8, 16)))).toBe('overflow');
    expect(code(convert('ff', s(8, 16)))).toBe('ok');
    expect(code(convert('111111111', u(8, 2)))).toBe('overflow');
    expect(code(convert('400', u(8, 8)))).toBe('overflow');
    expect(code(convert('377', u(8, 8)))).toBe('ok');
    expect(code(convert('0000000ff', u(8, 16)))).toBe('ok');
  });

  it('shows bytes in both orders for whole-byte widths', () => {
    const r = value(convert('0x12345678', u(32, 16)));
    expect(r.bytesBigEndian).toEqual(['12', '34', '56', '78']);
    expect(r.bytesLittleEndian).toEqual(['78', '56', '34', '12']);
    expect(r.bytesNote).toBeNull();
    expect(value(convert('1', u(16))).bytesBigEndian).toEqual(['00', '01']);
    expect(value(convert('1', u(16))).bytesLittleEndian).toEqual(['01', '00']);
    expect(value(convert('-2', s(16))).bytesBigEndian).toEqual(['ff', 'fe']);
    expect(value(convert('5', u(8))).bytesBigEndian).toEqual(['05']);
  });

  it('gives no bytes, with the reason, when the width is not a multiple of 8', () => {
    for (const w of [1, 7, 12, 31, 33]) {
      const r = value(convert('1', u(w)));
      expect(r.bytesBigEndian).toBeNull();
      expect(r.bytesLittleEndian).toBeNull();
      expect(r.bytesNote).toContain(`${w} bits`);
    }
  });

  it('passes parse errors through', () => {
    expect(code(convert('', u(8)))).toBe('empty');
    expect(code(convert('12x', u(8)))).toBe('invalid-digit');
    expect(code(convert('0x1', u(8)))).toBe('prefix-mismatch');
  });
});

describe('convert without a width', () => {
  it('shows a magnitude with a sign and no two\'s complement readings', () => {
    const r = value(convert('-255', s(null)));
    expect(r).toMatchObject({ binary: '-11111111', octal: '-377', hex: '-ff', decimal: '-255', pattern: null, unsignedReading: null, signedReading: null, width: null, bytesBigEndian: null, bytesLittleEndian: null });
    expect(r.bytesNote).toContain('negative');
    expect(r.notes).toHaveLength(1);
  });

  it('gives the fewest whole bytes for a non-negative value', () => {
    expect(value(convert('0', u(null))).bytesBigEndian).toEqual(['00']);
    expect(value(convert('255', u(null))).bytesBigEndian).toEqual(['ff']);
    expect(value(convert('256', u(null))).bytesBigEndian).toEqual(['01', '00']);
    expect(value(convert('256', u(null))).bytesLittleEndian).toEqual(['00', '01']);
    expect(value(convert('256', s(null))).notes).toEqual([]);
    expect(value(convert('256', s(null))).bytesNote).toBeNull();
  });

  it('keeps every digit of a very large value', () => {
    const big = 2n ** 4000n + 12345n;
    const r = value(convert(big.toString(), u(null)));
    expect(BigInt(`0x${r.hex}`)).toBe(big);
    expect(r.decimal).toBe(big.toString());
    expect(value(convert(r.hex, u(null, 16))).decimal).toBe(big.toString());
    expect(value(convert('9007199254740993', u(null))).hex).toBe('20000000000001');
  });
});

describe('display helpers', () => {
  it('groups digits from the right', () => {
    expect(groupDigits('1010101', 4)).toBe('101 0101');
    expect(groupDigits('11110000', 4)).toBe('1111 0000');
    expect(groupDigits('1111000011110000', 8)).toBe('11110000 11110000');
    expect(groupDigits('1', 4)).toBe('1');
    expect(groupDigits('-10101', 4)).toBe('-1 0101');
    expect(groupDigits('abcdef', 2, ':')).toBe('ab:cd:ef');
  });

  it('adds the usual prefixes', () => {
    expect(withPrefix('ff', 16)).toBe('0xff');
    expect(withPrefix('101', 2)).toBe('0b101');
    expect(withPrefix('17', 8)).toBe('0o17');
    expect(withPrefix('17', 10)).toBe('17');
    expect(withPrefix('-ff', 16)).toBe('-0xff');
  });
});

describe('storage units', () => {
  it('defines each unit exactly', () => {
    const bits = Object.fromEntries(UNITS.map(unit => [unit.id, unit.bits]));
    expect(bits).toEqual({
      bit: 1n, B: 8n,
      kB: 8000n, MB: 8000000n, GB: 8000000000n, TB: 8000000000000n, PB: 8000000000000000n, EB: 8000000000000000000n,
      KiB: 8192n, MiB: 8388608n, GiB: 8589934592n, TiB: 8796093022208n, PiB: 9007199254740992n, EiB: 9223372036854775808n,
    });
    expect(UNITS.filter(x => x.family === 'decimal').map(x => x.id)).toEqual(['kB', 'MB', 'GB', 'TB', 'PB', 'EB']);
    expect(UNITS.filter(x => x.family === 'binary').map(x => x.id)).toEqual(['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']);
    expect(findUnit('GiB')?.name).toBe('gibibyte');
    expect(findUnit('gb')).toBeNull();
  });

  it('parses plain decimal amounts exactly', () => {
    expect(value(parseAmount('1.5'))).toEqual({ num: 3n, den: 2n });
    expect(value(parseAmount('.25'))).toEqual({ num: 1n, den: 4n });
    expect(value(parseAmount('5.'))).toEqual({ num: 5n, den: 1n });
    expect(value(parseAmount(' 0.1 '))).toEqual({ num: 1n, den: 10n });
    expect(value(parseAmount('0'))).toEqual({ num: 0n, den: 1n });
    expect(value(parseAmount('0.000'))).toEqual({ num: 0n, den: 1n });
    expect(value(parseAmount('007'))).toEqual({ num: 7n, den: 1n });
  });

  it('refuses anything that is not a plain non-negative decimal', () => {
    expect(code(parseAmount(''))).toBe('empty');
    expect(code(parseAmount('  '))).toBe('empty');
    for (const bad of ['.', '-1', '+1', '1e3', '1,5', '1.2.3', '1 000', '0x10', 'ten', '1_000', 'NaN', 'Infinity']) expect(code(parseAmount(bad)), bad).toBe('invalid-amount');
    expect(code(parseAmount('1'.repeat(UNIT_LIMITS.amountChars)))).toBe('ok');
    expect(code(parseAmount('1'.repeat(UNIT_LIMITS.amountChars + 1)))).toBe('too-long');
    expect(code(convertAmount('1', 'XB'))).toBe('unit');
    expect(code(convertAmount('x', 'B'))).toBe('invalid-amount');
  });

  it('converts between decimal and binary units exactly', () => {
    const row = (amount: string, from: string, to: string) => value(convertAmount(amount, from)).rows.find(r => r.unit.id === to)!;
    expect(row('1', 'KiB', 'B').exact).toBe('1024');
    expect(row('1', 'kB', 'B').exact).toBe('1000');
    expect(row('1', 'B', 'bit').exact).toBe('8');
    expect(row('1', 'GiB', 'MiB').exact).toBe('1024');
    expect(row('1', 'GB', 'MB').exact).toBe('1000');
    expect(row('1', 'GiB', 'GB').exact).toBe('1.073741824');
    expect(row('500', 'GB', 'GiB').exact).toBe('465.661287307739257812500'.replace(/0+$/, ''));
    expect(row('1.5', 'MiB', 'KiB').exact).toBe('1536');
    expect(row('1', 'bit', 'B').exact).toBe('0.125');
    expect(row('1', 'EiB', 'B').exact).toBe('1152921504606846976');
    expect(row('1', 'EB', 'B').exact).toBe('1000000000000000000');
    expect(row('0', 'GB', 'KiB').exact).toBe('0');
  });

  it('says whether the amount is a whole number of bytes and bits', () => {
    expect(value(convertAmount('1.5', 'KiB')).wholeBytes).toBe(1536n);
    expect(value(convertAmount('12', 'bit')).wholeBytes).toBeNull();
    expect(value(convertAmount('12', 'bit')).wholeBits).toBe(12n);
    expect(value(convertAmount('16', 'bit')).wholeBytes).toBe(2n);
    expect(value(convertAmount('0.1', 'B')).wholeBytes).toBeNull();
    expect(value(convertAmount('0.1', 'B')).wholeBits).toBeNull();
    expect(value(convertAmount('0.1', 'B')).bits).toEqual({ num: 4n, den: 5n });
    expect(value(convertAmount('0.125', 'B')).wholeBits).toBe(1n);
  });

  it('adds a rounded form only when the exact fraction is long', () => {
    const rows = value(convertAmount('1', 'bit')).rows;
    const byId = Object.fromEntries(rows.map(r => [r.unit.id, r]));
    expect(byId.B).toMatchObject({ exact: '0.125', rounded: null });
    expect(byId.kB).toMatchObject({ exact: '0.000125', rounded: null });
    expect(byId.GB).toMatchObject({ exact: '0.000000000125', rounded: null });
    expect(byId.KiB.exact).toBe('0.0001220703125');
    expect(byId.KiB.rounded).toBe('0.0001220703125');
    expect(byId.MiB.exact).toBe('0.00000011920928955078125');
    expect(byId.MiB.rounded).toBe('0.000000119209289551');
  });

  it('writes exact decimals and refuses fractions that never end', () => {
    expect(exactDecimal({ num: 1n, den: 8n })).toBe('0.125');
    expect(exactDecimal({ num: 1n, den: 5n })).toBe('0.2');
    expect(exactDecimal({ num: 7n, den: 1n })).toBe('7');
    expect(exactDecimal({ num: 123n, den: 100n })).toBe('1.23');
    expect(exactDecimal({ num: 1n, den: 1024n })).toBe('0.0009765625');
    expect(exactDecimal({ num: 3n, den: 40n })).toBe('0.075');
    expect(exactDecimal({ num: 1n, den: 3n })).toBeNull();
    expect(exactDecimal({ num: 1n, den: 6n })).toBeNull();
    expect(exactDecimal({ num: 1n, den: 35n })).toBeNull();
  });

  it('rounds to significant digits, halves away from zero', () => {
    expect(roundedDecimal({ num: 1n, den: 3n }, 5)).toBe('0.33333');
    expect(roundedDecimal({ num: 2n, den: 3n }, 5)).toBe('0.66667');
    expect(roundedDecimal({ num: 2n, den: 3000n }, 3)).toBe('0.000667');
    expect(roundedDecimal({ num: 125n, den: 100n }, 2)).toBe('1.3');
    expect(roundedDecimal({ num: 124n, den: 100n }, 2)).toBe('1.2');
    expect(roundedDecimal({ num: 15n, den: 10n }, 1)).toBe('2');
    expect(roundedDecimal({ num: 999n, den: 1000n }, 2)).toBe('1');
    expect(roundedDecimal({ num: 123456n, den: 1n }, 3)).toBe('123000');
    expect(roundedDecimal({ num: 123500n, den: 1n }, 3)).toBe('124000');
    expect(roundedDecimal({ num: 5n, den: 1n }, 12)).toBe('5');
    expect(roundedDecimal({ num: 1n, den: 10n }, 12)).toBe('0.1');
    expect(roundedDecimal({ num: 10n, den: 1n }, 2)).toBe('10');
    expect(roundedDecimal({ num: 0n, den: 1n }, 12)).toBe('0');
  });

  it('reduces fractions', () => {
    expect(reduce(6n, 8n)).toEqual({ num: 3n, den: 4n });
    expect(reduce(0n, 8n)).toEqual({ num: 0n, den: 1n });
    expect(reduce(7n, 1n)).toEqual({ num: 7n, den: 1n });
  });
});
