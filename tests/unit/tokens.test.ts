import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hexEncode } from '../../src/core/codec/codec';
import {
  generate, inspectUuid, randomToken, TOKEN_LIMITS, UUID_V7_MAX_MS, UuidV7Generator, uuidV4, type RandomFill, type TokenKind,
} from '../../src/core/random/tokens';
import { rng } from '../helpers';

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A repeatable byte source, with a record of every request made to it. */
function seededFill(seed: number): RandomFill & { calls: number[] } {
  const random = rng(seed);
  const fill = ((bytes: Uint8Array) => {
    fill.calls.push(bytes.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  }) as RandomFill & { calls: number[] };
  fill.calls = [];
  return fill;
}

const constantFill = (value: number): RandomFill => bytes => { bytes.fill(value); };
const secureFill: RandomFill = bytes => { webcrypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>); };

afterEach(() => { vi.restoreAllMocks(); });

describe('UUID version 4', () => {
  it('produces the RFC 9562 appendix A.3 example from its 16 random bytes', () => {
    expect(uuidV4(bytes => bytes.set(bytesOf('919108f752d133205bacf847db4148a8')))).toBe('919108f7-52d1-4320-9bac-f847db4148a8');
  });

  it('sets the version to 4 and the variant to 10 whatever the random bytes are', () => {
    expect(uuidV4(constantFill(0x00))).toBe('00000000-0000-4000-8000-000000000000');
    expect(uuidV4(constantFill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidV4(constantFill(0xa5))).toBe('a5a5a5a5-a5a5-45a5-a5a5-a5a5a5a5a5a5');
  });

  it('keeps all 122 other bits from the random source', () => {
    const fill = seededFill(3);
    for (let i = 0; i < 2000; i++) {
      const before = fill.calls.length;
      let raw = new Uint8Array(0);
      const text = uuidV4(bytes => { fill(bytes); raw = bytes.slice(); });
      expect(fill.calls.length).toBe(before + 1);
      const got = bytesOf(text.replace(/-/g, ''));
      raw[6] = (raw[6] & 0x0f) | 0x40;
      raw[8] = (raw[8] & 0x3f) | 0x80;
      if (hexEncode(got) !== hexEncode(raw)) throw new Error(text);
      if (!UUID_FORMAT.test(text) || text[14] !== '4' || !'89ab'.includes(text[19])) throw new Error(text);
    }
    expect(fill.calls.every(n => n === 16)).toBe(true);
  });

  it('uses every variant nibble 8, 9, a and b', () => {
    const fill = seededFill(11);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(uuidV4(fill)[19]);
    expect([...seen].sort()).toEqual(['8', '9', 'a', 'b']);
  });

  it('asks for exactly 16 bytes, once', () => {
    const fill = seededFill(1);
    uuidV4(fill);
    expect(fill.calls).toEqual([16]);
  });
});

describe('UUID version 7', () => {
  const T = 0x017f22e279b0;

  it('lays out the timestamp, version, counter and variant as RFC 9562 section 5.7 says', () => {
    const g = new UuidV7Generator(constantFill(0xff), () => T);
    // 48-bit big-endian milliseconds, version 7, the counter seeded from 11 random bits, variant 10.
    expect(g.next()).toBe('017f22e2-79b0-77ff-bfff-ffffffffffff');
    const zero = new UuidV7Generator(constantFill(0x00), () => T);
    expect(zero.next()).toBe('017f22e2-79b0-7000-8000-000000000000');
  });

  it('writes the timestamp big-endian across all six bytes', () => {
    const at = (ms: number) => new UuidV7Generator(constantFill(0), () => ms).next().slice(0, 13);
    expect(at(0)).toBe('00000000-0000');
    expect(at(1)).toBe('00000000-0001');
    expect(at(0x0102030405_06)).toBe('01020304-0506');
    expect(at(UUID_V7_MAX_MS)).toBe('ffffffff-ffff');
    expect(UUID_V7_MAX_MS).toBe(281474976710655);
  });

  it('reproduces the RFC 9562 appendix A.6 example', () => {
    // The example has rand_a 0xCC3. The counter starts at 0x4C3 (its top bit is kept clear) and
    // reaches 0xCC3 on the 2,049th UUID of the millisecond; that call gets the example's rand_b.
    let call = 0;
    const fill: RandomFill = bytes => {
      bytes.set(call === 0x800 ? bytesOf('0000000000000000' + '18c4dc0c0c07398f') : bytesOf('00000000000004c3' + '0000000000000000'));
      call++;
    };
    const g = new UuidV7Generator(fill, () => 1645557742000);
    let last = '';
    for (let i = 0; i <= 0x800; i++) last = g.next();
    expect(last).toBe('017F22E2-79B0-7CC3-98C4-DC0C0C07398F'.toLowerCase());
    expect(inspectUuid(last)).toEqual({ version: 7, rfcVariant: true, timestampMs: 1645557742000 });
    expect(new Date(inspectUuid(last)!.timestampMs!).toISOString()).toBe('2022-02-22T19:22:22.000Z');
  });

  it('seeds the counter from 11 random bits, leaving the top bit clear', () => {
    const fill = seededFill(5);
    let clock = 1000;
    const g = new UuidV7Generator(fill, () => clock);
    const seeds = new Set<number>();
    for (let i = 0; i < 500; i++) {
      clock++;
      const counter = parseInt(g.next().slice(15, 18), 16);
      expect(counter).toBeLessThanOrEqual(0x7ff);
      seeds.add(counter);
    }
    expect(seeds.size).toBeGreaterThan(300);
  });

  it('counts up by one within a millisecond and keeps fresh random bits after the counter', () => {
    const fill = seededFill(8);
    const g = new UuidV7Generator(fill, () => T);
    const values = Array.from({ length: 50 }, () => g.next());
    const first = parseInt(values[0].slice(15, 18), 16);
    values.forEach((v, i) => {
      expect(v.slice(0, 14)).toBe('017f22e2-79b0-');
      expect(parseInt(v.slice(15, 18), 16)).toBe(first + i);
      expect(v[14]).toBe('7');
      expect('89ab').toContain(v[19]);
    });
    expect(new Set(values.map(v => v.slice(19))).size).toBe(50);
    expect([...values].sort()).toEqual(values);
  });

  it('moves the timestamp ahead when the counter runs out, instead of repeating', () => {
    const g = new UuidV7Generator(constantFill(0xff), () => T);
    const values = Array.from({ length: 2051 }, () => g.next());
    // Seeded at 0x7ff, the counter reaches 0xfff on the 2,049th value.
    expect(values[0].slice(0, 18)).toBe('017f22e2-79b0-77ff');
    expect(values[2048].slice(0, 18)).toBe('017f22e2-79b0-7fff');
    expect(values[2049].slice(0, 18)).toBe('017f22e2-79b1-77ff');
    // The clock still says T, which is now behind: counting continues in the borrowed millisecond.
    expect(values[2050].slice(0, 18)).toBe('017f22e2-79b1-7800');
    for (let i = 1; i < values.length; i++) if (!(values[i - 1].slice(0, 18) < values[i].slice(0, 18))) throw new Error(`not increasing at ${i}`);
  });

  it('never goes back when the clock does', () => {
    const times = [5000, 4000, 4999, 5000, 5001, 3000];
    let i = 0;
    const g = new UuidV7Generator(constantFill(0x00), () => times[i++]);
    const values = times.map(() => g.next());
    expect(values.map(v => v.slice(0, 18))).toEqual([
      '00000000-1388-7000', '00000000-1388-7001', '00000000-1388-7002', '00000000-1388-7003', '00000000-1389-7000', '00000000-1389-7001',
    ]);
    expect([...values].sort()).toEqual(values);
  });

  it('uses whole milliseconds', () => {
    expect(new UuidV7Generator(constantFill(0), () => 1000.9).next().slice(0, 13)).toBe('00000000-03e8');
  });

  it('refuses a clock outside the 48-bit range', () => {
    for (const bad of [-1, Number.NaN, 2 ** 48, Number.POSITIVE_INFINITY]) {
      expect(() => new UuidV7Generator(constantFill(0), () => bad).next()).toThrow(RangeError);
    }
    expect(() => new UuidV7Generator(constantFill(0), () => 0).next()).not.toThrow();
    // At the last millisecond there is nowhere to move to when the counter runs out.
    const g = new UuidV7Generator(constantFill(0xff), () => UUID_V7_MAX_MS);
    for (let i = 0; i < 2049; i++) g.next();
    expect(() => g.next()).toThrow(RangeError);
  });

  it('sorts in creation order across and within milliseconds with real randomness', () => {
    let clock = 1_700_000_000_000;
    let n = 0;
    const g = new UuidV7Generator(secureFill, () => (n++ % 7 === 0 ? ++clock : clock));
    const values = Array.from({ length: 5000 }, () => g.next());
    expect([...values].sort()).toEqual(values);
    expect(new Set(values).size).toBe(5000);
    for (const v of values) {
      const info = inspectUuid(v);
      if (!info || info.version !== 7 || !info.rfcVariant || info.timestampMs === null || info.timestampMs < 1_700_000_000_000) throw new Error(v);
    }
  });
});

describe('inspectUuid', () => {
  it('reads version, variant and the version 7 timestamp', () => {
    expect(inspectUuid('919108f7-52d1-4320-9bac-f847db4148a8')).toEqual({ version: 4, rfcVariant: true, timestampMs: null });
    expect(inspectUuid('017f22e2-79b0-7cc3-98c4-dc0c0c07398f')).toEqual({ version: 7, rfcVariant: true, timestampMs: 1645557742000 });
    expect(inspectUuid('00000000-0000-0000-0000-000000000000')).toEqual({ version: 0, rfcVariant: false, timestampMs: null });
    expect(inspectUuid('ffffffff-ffff-7fff-bfff-ffffffffffff')).toEqual({ version: 7, rfcVariant: true, timestampMs: 2 ** 48 - 1 });
  });

  it('recognizes only the 10xx variant as RFC 9562', () => {
    const variants = [...'0123456789abcdef'].filter(n => inspectUuid(`00000000-0000-4000-${n}000-000000000000`)!.rfcVariant);
    expect(variants).toEqual(['8', '9', 'a', 'b']);
    // A version 7 nibble under another variant carries no timestamp.
    expect(inspectUuid('017f22e2-79b0-7cc3-c8c4-dc0c0c07398f')).toEqual({ version: 7, rfcVariant: false, timestampMs: null });
  });

  it('accepts only the canonical lowercase form', () => {
    for (const bad of [
      '', '919108f7-52d1-4320-9bac-f847db4148a', '919108f7-52d1-4320-9bac-f847db4148a8a', '919108f752d143209bacf847db4148a8',
      '919108F7-52D1-4320-9BAC-F847DB4148A8', '919108f7-52d1-4320-9bac-f847db4148ag', '{919108f7-52d1-4320-9bac-f847db4148a8}',
      ' 919108f7-52d1-4320-9bac-f847db4148a8', '919108f7_52d1_4320_9bac_f847db4148a8', '919108f7-52d14320-9bac-f847db4148a8-',
    ]) expect(inspectUuid(bad)).toBeNull();
  });
});

describe('random tokens', () => {
  it('writes exactly the random bytes, as hex', () => {
    for (const n of [1, 2, 3, 15, 16, 17, 32, 33, 64, 255, 256, 1024]) {
      let raw = new Uint8Array(0);
      const fill = seededFill(n);
      const token = randomToken(bytes => { fill(bytes); raw = bytes.slice(); }, n, 'hex');
      expect(fill.calls).toEqual([n]);
      expect(token).toHaveLength(n * 2);
      expect(token).toMatch(/^[0-9a-f]+$/);
      expect(token).toBe(Buffer.from(raw).toString('hex'));
    }
  });

  it('writes exactly the random bytes, as unpadded Base64URL', () => {
    for (let n = 1; n <= 70; n++) {
      let raw = new Uint8Array(0);
      const fill = seededFill(n + 100);
      const token = randomToken(bytes => { fill(bytes); raw = bytes.slice(); }, n, 'base64url');
      expect(token).toHaveLength(Math.ceil((n * 4) / 3));
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token).toBe(Buffer.from(raw).toString('base64url'));
    }
    expect(randomToken(constantFill(0xff), 1024, 'base64url')).toHaveLength(1366);
    expect(randomToken(constantFill(0xfb), 2, 'base64url')).toBe('-_s');
  });
});

describe('generate', () => {
  const run = (kind: TokenKind, count: number, byteLength?: number, fill: RandomFill = seededFill(42), now = () => 1_700_000_000_000) => generate({ kind, count, byteLength }, fill, now);
  const good = (...args: Parameters<typeof run>) => {
    const result = run(...args);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const code = (...args: Parameters<typeof run>) => {
    const result = run(...args);
    return result.ok ? 'ok' : result.error.code;
  };

  it('states its limits', () => {
    expect(TOKEN_LIMITS).toEqual({ minBytes: 1, maxBytes: 1024, minCount: 1, maxCount: 1000 });
  });

  it('refuses a count outside 1 to 1,000 or one that is not a whole number', () => {
    for (const kind of ['uuid-v4', 'uuid-v7', 'hex', 'base64url'] as const) {
      for (const count of [0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(code(kind, count, 16)).toBe('count');
      expect(code(kind, 1, 16)).toBe('ok');
      expect(code(kind, 1000, 16)).toBe('ok');
    }
  });

  it('refuses a byte length outside 1 to 1,024 or one that is not a whole number', () => {
    for (const kind of ['hex', 'base64url'] as const) {
      for (const bytes of [0, -1, 1025, 2.5, Number.NaN, undefined]) expect(code(kind, 1, bytes)).toBe('bytes');
      expect(code(kind, 1, 1)).toBe('ok');
      expect(code(kind, 1, 1024)).toBe('ok');
    }
    // UUIDs have no byte length to get wrong.
    expect(code('uuid-v4', 1, 0)).toBe('ok');
    expect(code('uuid-v7', 1, undefined)).toBe('ok');
  });

  it('takes nothing from the random source when it refuses', () => {
    const fill = seededFill(1);
    run('hex', 0, 16, fill);
    run('hex', 5, 0, fill);
    run('uuid-v4', 1001, undefined, fill);
    expect(fill.calls).toEqual([]);
  });

  it('generates the requested number of version 4 UUIDs with 122 random bits each', () => {
    const fill = seededFill(2);
    const result = good('uuid-v4', 25, undefined, fill);
    expect(result.values).toHaveLength(25);
    expect(result.randomBits).toBe(122);
    expect(result.length).toBe(36);
    expect(fill.calls).toEqual(new Array(25).fill(16));
    for (const v of result.values) expect(inspectUuid(v)).toEqual({ version: 4, rfcVariant: true, timestampMs: null });
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('generates version 7 UUIDs in order, stamped with the clock, claiming only 62 random bits', () => {
    let clock = 1_700_000_000_000;
    const result = good('uuid-v7', 1000, undefined, seededFill(3), () => clock++ - (clock % 3));
    expect(result.values).toHaveLength(1000);
    expect(result.randomBits).toBe(62);
    expect(result.length).toBe(36);
    expect([...result.values].sort()).toEqual(result.values);
    expect(new Set(result.values).size).toBe(1000);
    for (const v of result.values) {
      const info = inspectUuid(v);
      if (!info || info.version !== 7 || !info.rfcVariant) throw new Error(v);
      if (info.timestampMs! < 1_699_999_999_990 || info.timestampMs! > 1_700_000_001_100) throw new Error(v);
    }
  });

  it('generates hex and Base64URL tokens of the right size and stated strength', () => {
    for (const bytes of [1, 8, 16, 32, 64, 1024]) {
      const hex = good('hex', 3, bytes);
      expect(hex.values).toHaveLength(3);
      expect(hex.randomBits).toBe(bytes * 8);
      expect(hex.length).toBe(bytes * 2);
      for (const v of hex.values) expect(v).toMatch(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
      const b64 = good('base64url', 3, bytes);
      expect(b64.randomBits).toBe(bytes * 8);
      expect(b64.length).toBe(Math.ceil((bytes * 4) / 3));
      for (const v of b64.values) expect(v).toMatch(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));
    }
  });

  it('adds a caution for tokens shorter than 16 bytes', () => {
    expect(good('hex', 1, 15).notes.length).toBe(good('hex', 1, 16).notes.length + 1);
    expect(good('base64url', 1, 1).notes.length).toBe(good('base64url', 1, 1024).notes.length + 1);
  });

  it('is fully determined by the random source and the clock, and never touches Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random must not be used'); });
    for (const kind of ['uuid-v4', 'uuid-v7', 'hex', 'base64url'] as const) {
      const a = good(kind, 20, 24, seededFillNoMath(7));
      const b = good(kind, 20, 24, seededFillNoMath(7));
      const c = good(kind, 20, 24, seededFillNoMath(8));
      expect(a.values).toEqual(b.values);
      expect(a.values).not.toEqual(c.values);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('gives 1,000 distinct values of every kind from a secure source', () => {
    for (const kind of ['uuid-v4', 'uuid-v7', 'hex', 'base64url'] as const) {
      const result = good(kind, 1000, 16, secureFill, () => Date.now());
      expect(new Set(result.values).size).toBe(1000);
    }
  });

  it('spreads random token bytes over all values', () => {
    const result = good('hex', 1000, 64, secureFill);
    const counts = new Array<number>(16).fill(0);
    for (const v of result.values) for (const ch of v) counts[parseInt(ch, 16)]++;
    // 128,000 hex digits: each of the 16 values is expected 8,000 times.
    for (const n of counts) expect(Math.abs(n - 8000)).toBeLessThan(600);
  });
});

/** A linear congruential byte source that does not use Math at all. */
function seededFillNoMath(seed: number): RandomFill {
  let state = seed >>> 0;
  return bytes => {
    for (let i = 0; i < bytes.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes[i] = state >>> 24;
    }
  };
}
