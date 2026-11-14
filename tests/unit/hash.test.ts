import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64Encode, hexEncode } from '../../src/core/codec/codec';
import {
  digest, digestText, HASHES, hmac, HMAC_HASHES, matchExpected, MAX_HASH_BYTES, parseKey, type HashId, type HmacHashId, type Subtle,
} from '../../src/core/crypto/digest';
import { md5 } from '../../src/core/crypto/md5';

const subtle = webcrypto.subtle as unknown as Subtle;
const ascii = (text: string) => Uint8Array.from([...text].map(ch => ch.charCodeAt(0)));

function bytesOf(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const md5Hex = (data: Uint8Array) => hexEncode(md5(data));

/** The MD5 test suite printed in RFC 1321, appendix A.5, copied from the RFC text. */
const RFC1321: [string, string][] = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
];

/**
 * Secure Hash Standard examples (FIPS 180, and the NIST example files): "abc", the empty message,
 * the 448-bit and 896-bit messages, and one million repetitions of "a".
 */
const M448 = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
const M896 = 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
const SHA_VECTORS: Record<'abc' | 'empty' | 'm448' | 'm896' | 'million', Record<'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512', string>> = {
  abc: { 'SHA-1': 'a9993e364706816aba3e25717850c26c9cd0d89d', 'SHA-256': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-384': 'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7', 'SHA-512': 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f' },
  empty: { 'SHA-1': 'da39a3ee5e6b4b0d3255bfef95601890afd80709', 'SHA-256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'SHA-384': '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b', 'SHA-512': 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e' },
  m448: { 'SHA-1': '84983e441c3bd26ebaae4aa1f95129e5e54670f1', 'SHA-256': '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', 'SHA-384': '3391fdddfc8dc7393707a65b1b4709397cf8b1d162af05abfe8f450de5f36bc6b0455a8520bc4e6f5fe95b1fe3c8452b', 'SHA-512': '204a8fc6dda82f0a0ced7beb8e08a41657c16ef468b228a8279be331a703c33596fd15c13b1b07f9aa1d3bea57789ca031ad85c7a71dd70354ec631238ca3445' },
  m896: { 'SHA-1': 'a49b2446a02c645bf419f995b67091253a04a259', 'SHA-256': 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1', 'SHA-384': '09330c33f71147e83d192fc782cd1b4753111b173b3b05d22fa08086e3b0f712fcc7c71a557e2db966c3e9fa91746039', 'SHA-512': '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909' },
  million: { 'SHA-1': '34aa973cd4c4daa4f61eeb2bdbad27316534016f', 'SHA-256': 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0', 'SHA-384': '9d0e1809716474cb086e834e310a4a1ced149e9c00f248527972cec5704c2a5b07b8b3dc38ecc4ebae97ddd87f3d8985', 'SHA-512': 'e718483d0ce769644e2e42c7bc15b4638e1f98b13b2044285632a803afa973ebde0ff244877ea60a4cb0432ce577c31beb009c5c2c49aa2e4eadb217ad8cc09b' },
};

/** RFC 4231 section 4, test cases 1 to 7, copied from the RFC text. Case 5 gives only the first 128 bits. */
const RFC4231: { n: number; key: string; data: string; 'SHA-256': string; 'SHA-384': string; 'SHA-512': string }[] = [
  { n: 1, key: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', data: '4869205468657265', 'SHA-256': 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7', 'SHA-384': 'afd03944d84895626b0825f4ab46907f15f9dadbe4101ec682aa034c7cebc59cfaea9ea9076ede7f4af152e8b2fa9cb6', 'SHA-512': '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854' },
  { n: 2, key: '4a656665', data: '7768617420646f2079612077616e7420666f72206e6f7468696e673f', 'SHA-256': '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'SHA-384': 'af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e8e2240ca5e69e2c78b3239ecfab21649', 'SHA-512': '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737' },
  { n: 3, key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'SHA-256': '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe', 'SHA-384': '88062608d3e6ad8a0aa2ace014c8a86f0aa635d947ac9febe83ef4e55966144b2a5ab39dc13814b94e3ab6e101a34f27', 'SHA-512': 'fa73b0089d56a284efb0f0756c890be9b1b5dbdd8ee81a3655f83e33b2279d39bf3e848279a722c806b485a47e67c807b946a337bee8942674278859e13292fb' },
  { n: 4, key: '0102030405060708090a0b0c0d0e0f10111213141516171819', data: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', 'SHA-256': '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b', 'SHA-384': '3e8a69b7783c25851933ab6290af6ca77a9981480850009cc5577c6e1f573b4e6801dd23c4a7d679ccf8a386c674cffb', 'SHA-512': 'b0ba465637458c6990e5a8c5f61d4af7e576d97ff94b872de76f8050361ee3dba91ca5c11aa25eb4d679275cc5788063a5f19741120c4f2de2adebeb10a298dd' },
  { n: 5, key: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c', data: '546573742057697468205472756e636174696f6e', 'SHA-256': 'a3b6167473100ee06e0c796c2955552b', 'SHA-384': '3abf34c3503b2a23a46efc619baef897', 'SHA-512': '415fad6271580a531d4179bc891d87a6' },
  { n: 6, key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data: '54657374205573696e67204c6172676572205468616e20426c6f636b2d53697a65204b6579202d2048617368204b6579204669727374', 'SHA-256': '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54', 'SHA-384': '4ece084485813e9088d2c63a041bc5b44f9ef1012a2b588f3cd11f05033ac4c60c2ef6ab4030fe8296248df163f44952', 'SHA-512': '80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598' },
  { n: 7, key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data: '5468697320697320612074657374207573696e672061206c6172676572207468616e20626c6f636b2d73697a65206b657920616e642061206c6172676572207468616e20626c6f636b2d73697a6520646174612e20546865206b6579206e6565647320746f20626520686173686564206265666f7265206265696e6720757365642062792074686520484d414320616c676f726974686d2e', 'SHA-256': '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2', 'SHA-384': '6617178e941f020d351e2f254e8fd32c602420feb0b8fb9adccebb82461e99c5a678cc31e799176d3860e6110c46523e', 'SHA-512': 'e37b6a775dc87dbaa4dfa9f96e5e3ffddebd71f8867289865df5a32d20cdc944b6022cac3c4982b10d5eeb55c3e4de15134676fb6de0446065c97440fa8c6a58' },
];

describe('MD5', () => {
  it('passes the complete RFC 1321 test suite', () => {
    expect(RFC1321).toHaveLength(7);
    for (const [message, want] of RFC1321) expect(md5Hex(ascii(message))).toBe(want);
  });

  it('returns 16 bytes', () => {
    expect(md5(new Uint8Array(0))).toHaveLength(16);
    expect(md5(new Uint8Array(1000))).toBeInstanceOf(Uint8Array);
  });

  // Known digests of n zero bytes, at every length around the padding boundaries (from Python hashlib).
  const ZEROS: [number, string][] = [
    [0, 'd41d8cd98f00b204e9800998ecf8427e'],
    [1, '93b885adfe0da089cdf634904fd59f71'],
    [55, 'c9ea3314b91c9fd4e38f9432064fd1f2'],
    [56, 'e3c4dd21a9171fd39d208efa09bf7883'],
    [57, 'ab9d8ef2ffa9145d6c325cefa41d5d4e'],
    [63, '65cecfb980d72fde57d175d6ec1c3f64'],
    [64, '3b5d3c7d207e37dceeedd301e35e2e58'],
    [65, '1ef5e829303a139ce967440e0cdca10c'],
    [119, '8271cb2e6a546123b43096a2efce39d2'],
    [120, '222f7d881ded1871724a1b9a1cb94247'],
    [121, '709c6a80af0276b170c521117ede47c6'],
    [128, 'f09f35a5637839458e462e6350ecbce4'],
  ];

  it('pads correctly at every block boundary', () => {
    expect(ZEROS.map(z => z[0])).toEqual([0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128]);
    for (const [n, want] of ZEROS) expect(md5Hex(new Uint8Array(n))).toBe(want);
  });

  it('distinguishes messages that differ only in length', () => {
    const seen = new Set<string>();
    for (let n = 0; n <= 200; n++) seen.add(md5Hex(new Uint8Array(n).fill(0x61)));
    expect(seen.size).toBe(201);
  });

  it('matches the platform MD5 for a multi-megabyte input and at awkward lengths', async () => {
    const { createHash } = await import('node:crypto');
    const big = new Uint8Array(5 * 1024 * 1024 + 3);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    expect(md5Hex(big)).toBe(createHash('md5').update(big).digest('hex'));
    for (const n of [1, 54, 55, 56, 63, 64, 65, 127, 128, 129, 1023, 4096, 65_535]) {
      const part = big.subarray(7, 7 + n);
      expect(md5Hex(part)).toBe(createHash('md5').update(part).digest('hex'));
    }
  });

  it('does not modify its input and reads a view at its own offset', () => {
    const backing = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    const copy = backing.slice();
    const view = backing.subarray(100, 200);
    expect(md5Hex(view)).toBe(md5Hex(view.slice()));
    expect([...backing]).toEqual([...copy]);
  });

  it('hashes 64 MB in a reasonable time', () => {
    const data = new Uint8Array(64 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 4099) data[i] = i & 0xff;
    const start = performance.now();
    const hex = md5Hex(data);
    const elapsed = performance.now() - start;
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
    expect(elapsed).toBeLessThan(20_000);
  });
});

describe('digest', () => {
  it('lists five algorithms, with the legacy two marked', () => {
    expect(HASHES.map(h => h.id)).toEqual(['SHA-256', 'SHA-384', 'SHA-512', 'SHA-1', 'MD5']);
    expect(HASHES.map(h => h.bits)).toEqual([256, 384, 512, 160, 128]);
    expect(HASHES.filter(h => h.caution !== null).map(h => h.id)).toEqual(['SHA-1', 'MD5']);
    expect(HASHES.find(h => h.id === 'SHA-1')!.caution).toMatch(/^Legacy/);
    expect(HASHES.find(h => h.id === 'MD5')!.caution).toMatch(/^Legacy/);
    expect(HASHES.find(h => h.id === 'MD5')!.caution).toMatch(/[Nn]ot suitable/);
    expect(MAX_HASH_BYTES).toBe(512 * 1024 * 1024);
  });

  it('produces digests of the stated size', async () => {
    for (const h of HASHES) expect((await digest(subtle, h.id, ascii('x'))).length * 8).toBe(h.bits);
  });

  const messages: Record<keyof typeof SHA_VECTORS, () => Uint8Array> = {
    abc: () => ascii('abc'),
    empty: () => new Uint8Array(0),
    m448: () => ascii(M448),
    m896: () => ascii(M896),
    million: () => new Uint8Array(1_000_000).fill(0x61),
  };

  it.each(Object.keys(SHA_VECTORS) as (keyof typeof SHA_VECTORS)[])('matches the published SHA vectors for the "%s" message', async name => {
    expect(M448).toHaveLength(56);
    expect(M896).toHaveLength(112);
    const data = messages[name]();
    for (const id of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const) {
      expect(hexEncode(await digest(subtle, id, data))).toBe(SHA_VECTORS[name][id]);
    }
  });

  it('routes MD5 to the local implementation and everything else to Web Crypto', async () => {
    const calls: string[] = [];
    const spy: Subtle = {
      digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => { calls.push(String(algorithm)); return subtle.digest(algorithm, data); },
      importKey: subtle.importKey.bind(subtle) as Subtle['importKey'],
      sign: subtle.sign.bind(subtle) as Subtle['sign'],
    };
    expect(hexEncode(await digest(spy, 'MD5', ascii('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(calls).toEqual([]);
    for (const id of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as HashId[]) await digest(spy, id, ascii('abc'));
    expect(calls).toEqual(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);
  });
});

describe('HMAC', () => {
  it('lists the three HMAC algorithms', () => {
    expect(HMAC_HASHES.map(h => [h.id, h.label, h.bits])).toEqual([['SHA-256', 'HMAC-SHA256', 256], ['SHA-384', 'HMAC-SHA384', 384], ['SHA-512', 'HMAC-SHA512', 512]]);
  });

  it.each(RFC4231)('matches RFC 4231 test case $n', async vector => {
    const key = bytesOf(vector.key);
    const data = bytesOf(vector.data);
    for (const id of ['SHA-256', 'SHA-384', 'SHA-512'] as HmacHashId[]) {
      const got = hexEncode(await hmac(subtle, id, key, data));
      // Test case 5 is a truncation test: the RFC lists the first 128 bits only.
      if (vector.n === 5) expect(got.slice(0, 32)).toBe(vector[id]);
      else expect(got).toBe(vector[id]);
      expect(got).toHaveLength(id === 'SHA-256' ? 64 : id === 'SHA-384' ? 96 : 128);
    }
  });

  it('covers all seven RFC 4231 cases, including keys longer than a block', () => {
    expect(RFC4231.map(v => v.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(RFC4231[5].key).toHaveLength(262);
    expect(RFC4231[0].key).toBe('0b'.repeat(20));
  });

  it('refuses an empty key before calling Web Crypto', async () => {
    let called = false;
    const spy: Subtle = {
      digest: subtle.digest.bind(subtle) as Subtle['digest'],
      importKey: (() => { called = true; throw new Error('should not be reached'); }) as unknown as Subtle['importKey'],
      sign: subtle.sign.bind(subtle) as Subtle['sign'],
    };
    await expect(hmac(spy, 'SHA-256', new Uint8Array(0), ascii('data'))).rejects.toThrow(RangeError);
    expect(called).toBe(false);
  });

  it('accepts a one-byte key and empty data', async () => {
    const { createHmac } = await import('node:crypto');
    const got = hexEncode(await hmac(subtle, 'SHA-256', Uint8Array.of(0), new Uint8Array(0)));
    expect(got).toBe(createHmac('sha256', Buffer.from([0])).update('').digest('hex'));
  });

  it('gives different results for different keys, data and hashes', async () => {
    const results = new Set<string>();
    for (const id of ['SHA-256', 'SHA-384', 'SHA-512'] as HmacHashId[]) {
      for (const key of ['k1', 'k2']) for (const data of ['d1', 'd2']) results.add(hexEncode(await hmac(subtle, id, ascii(key), ascii(data))));
    }
    expect(results.size).toBe(12);
  });
});

describe('parseKey', () => {
  const ok = (text: string, format: Parameters<typeof parseKey>[1]) => {
    const result = parseKey(text, format);
    if (!result.ok) throw new Error(result.error.code);
    return [...result.value];
  };
  const code = (text: string, format: Parameters<typeof parseKey>[1]) => {
    const result = parseKey(text, format);
    return result.ok ? 'ok' : result.error.code;
  };

  it('reads text as UTF-8 exactly as typed, spaces included', () => {
    expect(ok('key', 'text')).toEqual([0x6b, 0x65, 0x79]);
    expect(ok(' key ', 'text')).toEqual([0x20, 0x6b, 0x65, 0x79, 0x20]);
    expect(ok(String.fromCodePoint(0x20ac), 'text')).toEqual([0xe2, 0x82, 0xac]);
    expect(ok(' ', 'text')).toEqual([0x20]);
  });

  it('reads hex in either case, ignoring surrounding whitespace only', () => {
    expect(ok('0b0B', 'hex')).toEqual([0x0b, 0x0b]);
    expect(ok('  deadbeef  ', 'hex')).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(code('de ad', 'hex')).toBe('key-invalid');
    expect(code('abc', 'hex')).toBe('key-invalid');
    expect(code('xyz!', 'hex')).toBe('key-invalid');
  });

  it('reads Base64 in both alphabets, with or without padding', () => {
    expect(ok('+/8=', 'base64')).toEqual([0xfb, 0xff]);
    expect(ok('+/8', 'base64')).toEqual([0xfb, 0xff]);
    expect(ok('-_8', 'base64')).toEqual([0xfb, 0xff]);
    expect(ok('-_8=', 'base64')).toEqual([0xfb, 0xff]);
    expect(ok(' a2V5 ', 'base64')).toEqual([0x6b, 0x65, 0x79]);
    expect(code('a2V5!', 'base64')).toBe('key-invalid');
    expect(code('+_8=', 'base64')).toBe('key-invalid');
    expect(code('a2 V5', 'base64')).toBe('key-invalid');
    expect(code('a2V', 'base64')).toBe('key-invalid');
    expect(code('a', 'base64')).toBe('key-invalid');
  });

  it('refuses an empty key in every format', () => {
    expect(code('', 'text')).toBe('key-empty');
    expect(code('', 'hex')).toBe('key-empty');
    expect(code('   ', 'hex')).toBe('key-empty');
    expect(code('', 'base64')).toBe('key-empty');
    expect(code('  ', 'base64')).toBe('key-empty');
  });

  it('refuses text with an unpaired surrogate', () => {
    expect(code(`k${String.fromCharCode(0xd800)}`, 'text')).toBe('key-invalid');
  });

  it('gives the key RFC 4231 test case 2 uses, in all three formats', async () => {
    const want = RFC4231[1]['SHA-256'];
    const data = bytesOf(RFC4231[1].data);
    for (const [text, format] of [['Jefe', 'text'], ['4a656665', 'hex'], ['SmVmZQ==', 'base64'], ['SmVmZQ', 'base64']] as const) {
      const key = parseKey(text, format);
      expect(key.ok && hexEncode(await hmac(subtle, 'SHA-256', key.value, data))).toBe(want);
    }
  });
});

describe('digestText and matchExpected', () => {
  const abc = { hex: '900150983cd24fb0d6963f7d28e17f72', base64: 'kAFQmDzST7DWlj99KOF/cg==' };

  it('writes a digest as lowercase hex and padded standard Base64', () => {
    const bytes = md5(ascii('abc'));
    expect(digestText(bytes)).toEqual(abc);
    expect(digestText(Uint8Array.of(0xfb, 0xff))).toEqual({ hex: 'fbff', base64: '+/8=' });
    expect(digestText(bytes).base64).toBe(base64Encode(bytes));
  });

  it('finds the digest that matches a published value', () => {
    const other = { hex: 'ffff', base64: '//8=' };
    expect(matchExpected(abc.hex, [other, abc])).toEqual({ index: 1, form: 'hex' });
    expect(matchExpected(abc.hex.toUpperCase(), [other, abc])).toEqual({ index: 1, form: 'hex' });
    expect(matchExpected(`  ${abc.hex}\n`, [abc])).toEqual({ index: 0, form: 'hex' });
    expect(matchExpected(abc.base64, [other, abc])).toEqual({ index: 1, form: 'base64' });
    expect(matchExpected(` ${abc.base64} `, [abc])).toEqual({ index: 0, form: 'base64' });
  });

  it('compares Base64 exactly, and reports no match otherwise', () => {
    expect(matchExpected(abc.base64.toLowerCase(), [abc])).toBeNull();
    expect(matchExpected(abc.hex.slice(0, -1), [abc])).toBeNull();
    expect(matchExpected(`${abc.hex}0`, [abc])).toBeNull();
    expect(matchExpected('', [abc])).toBeNull();
    expect(matchExpected('   ', [abc])).toBeNull();
    expect(matchExpected(abc.hex, [])).toBeNull();
  });

  it('returns the first match when two digests are equal', () => {
    expect(matchExpected(abc.hex, [abc, abc])).toEqual({ index: 0, form: 'hex' });
  });
});
