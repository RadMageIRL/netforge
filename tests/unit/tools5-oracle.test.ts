/**
 * Number Bases & Bytes and the chmod Calculator against independent references:
 * - tests/fixtures/tools5-oracle.json, made by scripts/oracles/tools5_oracle.py from the Python
 *   standard library (int and int.to_bytes, fractions and decimal, stat.filemode);
 * - tests/fixtures/chmod-oracle.json, made by scripts/oracles/chmod_oracle.py from the real GNU
 *   coreutils chmod running in Linux.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bitsNeeded, convert, type Base } from '../../src/core/numbers/bases';
import { convertAmount, roundedDecimal, UNITS } from '../../src/core/numbers/units';
import { applyNumeric, applySymbolic, formatLs, formatOctal, formatSymbolic, parseLsMode, parseOctalMode } from '../../src/core/perm/chmod';

interface FixedCase { width: number; signed: boolean; value: string; unsigned: string; signedReading: string; binary: string; octal: string; hex: string; be: string[] | null; le: string[] | null }
interface OverflowCase { width: number; signed: boolean; value?: string; pattern?: Record<string, string>; code: string }
interface UnboundedCase { value: string; binary: string; octal: string; hex: string; be: string[] | null; unsignedBits: number | null; signedBits: number }
interface UnitCase { amount: string; from: string; bits: [string, string]; wholeBytes: string | null; rows: Record<string, { exact: string; rounded12: string }> }
interface Tools5 {
  numbers: { fixed: FixedCase[]; overflow: OverflowCase[]; unbounded: UnboundedCase[] };
  units: UnitCase[];
  modes: [number, string, string][];
}
interface ChmodOracle {
  source: string;
  symbolic: { expr: string; start: number; dir: boolean; umask: number; status: number; invalid: boolean; result: number | null }[];
  numeric: { digits: string; start: number; dir: boolean; status: number; result: number }[];
}

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8')) as unknown;
const tools = fixture('tools5-oracle.json') as Tools5;
const chmod = fixture('chmod-oracle.json') as ChmodOracle;

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

describe('fixed-width integers against Python int', () => {
  it('has a useful number of cases', () => {
    expect(tools.numbers.fixed.length).toBeGreaterThan(500);
    expect(tools.numbers.overflow.length).toBeGreaterThan(200);
    expect(tools.numbers.unbounded.length).toBeGreaterThan(100);
  });

  it('converts a decimal value to every base, both readings and both byte orders', () => {
    for (const c of tools.numbers.fixed) {
      const r = must(convert(c.value, { base: 10, signed: c.signed, width: c.width }));
      const got = { binary: r.binary, octal: r.octal, hex: r.hex, decimal: r.decimal, unsigned: String(r.unsignedReading), signedReading: String(r.signedReading), be: r.bytesBigEndian, le: r.bytesLittleEndian };
      expect(got, `${c.value} at ${c.width} ${c.signed}`).toEqual({ binary: c.binary, octal: c.octal, hex: c.hex, decimal: c.value, unsigned: c.unsigned, signedReading: c.signedReading, be: c.be, le: c.le });
    }
  });

  it('reads the bit pattern back from binary, octal and hex as the same value', () => {
    for (const c of tools.numbers.fixed) {
      for (const [base, text] of [[2, c.binary], [8, c.octal], [16, c.hex]] as [Base, string][]) {
        // An octal pattern padded to a whole number of digits can be wider than the width only in its zero bits.
        const r = must(convert(text, { base, signed: c.signed, width: c.width }));
        expect(r.decimal, `${text} base ${base} at ${c.width}`).toBe(c.signed ? c.signedReading : c.unsigned);
        expect(r.hex).toBe(c.hex);
      }
    }
  });

  it('refuses every value and pattern outside the width', () => {
    for (const c of tools.numbers.overflow) {
      if (c.value !== undefined) {
        const r = convert(c.value, { base: 10, signed: c.signed, width: c.width });
        expect(r.ok ? 'ok' : r.error.code, `${c.value} at ${c.width} ${c.signed}`).toBe(c.code);
      } else {
        for (const base of [2, 8, 16] as Base[]) {
          const r = convert(c.pattern![String(base)], { base, signed: c.signed, width: c.width });
          expect(r.ok ? 'ok' : r.error.code).toBe('overflow');
        }
      }
    }
  });

  it('converts values of any size without a width', () => {
    for (const c of tools.numbers.unbounded) {
      const r = must(convert(c.value, { base: 10, signed: true, width: null }));
      expect({ binary: r.binary, octal: r.octal, hex: r.hex, be: r.bytesBigEndian, bits: r.bitsNeeded }, c.value)
        .toEqual({ binary: c.binary, octal: c.octal, hex: c.hex, be: c.be, bits: c.signedBits });
      if (c.unsignedBits !== null) expect(bitsNeeded(BigInt(c.value), false)).toBe(c.unsignedBits);
      if (!c.value.startsWith('-')) {
        expect(must(convert(c.hex, { base: 16, signed: false, width: null })).decimal).toBe(c.value);
        expect(must(convert(c.binary, { base: 2, signed: false, width: null })).decimal).toBe(c.value);
        expect(must(convert(c.octal, { base: 8, signed: false, width: null })).decimal).toBe(c.value);
      }
    }
  });
});

describe('storage units against Python fractions and decimal', () => {
  it('has a useful number of cases', () => {
    expect(tools.units.length).toBeGreaterThan(400);
  });

  it('gives the exact amount in every unit', () => {
    for (const c of tools.units) {
      const r = must(convertAmount(c.amount, c.from));
      expect([String(r.bits.num), String(r.bits.den)], `${c.amount} ${c.from}`).toEqual(c.bits);
      expect(r.wholeBytes === null ? null : String(r.wholeBytes)).toBe(c.wholeBytes);
      expect(r.rows.map(row => row.unit.id)).toEqual(UNITS.map(u => u.id));
      for (const row of r.rows) {
        const want = c.rows[row.unit.id];
        expect(row.exact, `${c.amount} ${c.from} in ${row.unit.id}`).toBe(want.exact);
        if (row.rounded !== null) expect(row.rounded, `${c.amount} ${c.from} in ${row.unit.id} rounded`).toBe(want.rounded12);
      }
    }
  });

  it('rounds to 12 significant digits, halves up, like decimal.quantize', () => {
    let checked = 0;
    for (const c of tools.units) {
      const bits = { num: BigInt(c.bits[0]), den: BigInt(c.bits[1]) };
      for (const unit of UNITS) {
        expect(roundedDecimal({ num: bits.num, den: bits.den * unit.bits }, 12), `${c.amount} ${c.from} in ${unit.id}`).toBe(c.rows[unit.id].rounded12);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(6000);
  });
});

describe('mode strings against Python stat.filemode', () => {
  it('formats and parses all 4,096 modes', () => {
    expect(tools.modes).toHaveLength(4096);
    for (const [mode, ls, octal] of tools.modes) {
      expect(formatLs(mode)).toBe(ls);
      expect(must(parseLsMode(ls)).mode).toBe(mode);
      expect(must(parseLsMode(`d${ls}`))).toEqual({ mode, type: 'd' });
      expect(parseInt(formatOctal(mode), 8)).toBe(mode);
      expect(formatOctal(mode)).toBe(octal.padStart(mode > 0o777 ? 4 : 3, '0'));
      expect(must(parseOctalMode(octal.padStart(4, '0')))).toBe(mode);
    }
  });
});

describe('symbolic modes against GNU chmod', () => {
  it('comes from GNU coreutils and has a useful number of cases', () => {
    expect(chmod.source).toMatch(/^chmod \(GNU coreutils\) \d/);
    expect(chmod.symbolic.length).toBeGreaterThan(3000);
    expect(chmod.symbolic.filter(c => c.invalid).length).toBeGreaterThan(50);
    expect(chmod.numeric.length).toBeGreaterThan(300);
  });

  it('gives the mode GNU chmod leaves, for files and directories under each umask', () => {
    for (const c of chmod.symbolic) {
      const r = applySymbolic(c.start, c.expr, { directory: c.dir, umask: c.umask });
      const label = `chmod ${c.expr} on ${c.dir ? 'directory' : 'file'} ${c.start.toString(8)} umask ${c.umask.toString(8)}`;
      if (c.invalid) expect(r.ok, label).toBe(false);
      else expect(r.ok ? r.value.toString(8) : r.error.code, label).toBe(c.result!.toString(8));
    }
  });

  it('the canonical symbolic form sets exactly the mode on a file, as GNU chmod would', () => {
    // formatSymbolic output is checked through the engine that the cases above pin to GNU chmod.
    for (const [mode] of tools.modes) {
      for (const start of [0, 0o7777, 0o644]) {
        expect(must(applySymbolic(start, formatSymbolic(mode), { directory: false, umask: 0o777 }))).toBe(mode);
        expect(must(applySymbolic(start, formatSymbolic(mode, true), { directory: true, umask: 0o777 }))).toBe(mode);
      }
    }
  });

  it('numeric modes keep setuid and setgid on a directory unless five digits are written', () => {
    for (const c of chmod.numeric) {
      expect(must(applyNumeric(c.start, c.digits, c.dir)).toString(8), `chmod ${c.digits} on ${c.dir ? 'directory' : 'file'} ${c.start.toString(8)}`).toBe(c.result.toString(8));
    }
  });
});
