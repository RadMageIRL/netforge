#!/usr/bin/env python3
"""Reference results for the Phase 4 utility engines, from the Python standard library.

Writes tests/fixtures/utils-oracle.json, which tests/unit/utils-oracle.test.ts checks NetForge's
encoders, hashes, UUID reader and text sorting against. Python's codecs, base64, binascii,
urllib.parse, hashlib, hmac, uuid and sorted() are independent implementations of the same rules.

The output is deterministic (a fixed seed), so running this twice gives the same file.

    python scripts/oracles/utils_oracle.py
"""
import base64
import binascii
import hashlib
import hmac
import json
import random
import re
import urllib.parse
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'utils-oracle.json'
rnd = random.Random(20261114)


def rand_bytes(n):
    return bytes(rnd.randrange(256) for _ in range(n))


def rand_text(n):
    """Text mixing ASCII, Latin-1, BMP, private-use and astral characters. No surrogates."""
    pools = [
        (0x20, 0x7e), (0x20, 0x7e), (0xa0, 0xff), (0x100, 0x24f), (0x370, 0x3ff), (0x4e00, 0x4e80),
        (0xe000, 0xe010), (0xff00, 0xff60), (0x1f600, 0x1f64f), (0x10000, 0x10020), (0x10fff0, 0x10ffff),
    ]
    out = []
    for _ in range(n):
        lo, hi = rnd.choice(pools)
        out.append(chr(rnd.randint(lo, hi)))
    return ''.join(out)


# UTF-8 validity -------------------------------------------------------------------------------

def utf8_case(data):
    try:
        text = data.decode('utf-8')
        return {'hex': data.hex(), 'valid': True, 'text': text}
    except UnicodeDecodeError as e:
        return {'hex': data.hex(), 'valid': False, 'start': e.start}


def utf8_cases():
    cases = []
    fixed = [
        '', '00', '7f', '80', 'bf', 'c0', 'c1', 'c080', 'c1bf', 'c2', 'c280', 'c27f', 'dfbf', 'e0', 'e080', 'e09f80', 'e0a080',
        'e0a0', 'e18080', 'e180', 'ed9fbf', 'eda080', 'edbfbf', 'ee8080', 'efbfbd', 'efbfbf', 'efbbbf41', 'f0', 'f08080', 'f08f8080',
        'f0908080', 'f09080', 'f090', 'f48fbfbf', 'f4908080', 'f5808080', 'f8888080', 'fc', 'fe', 'ff', '41ff42', '4180', 'c2c280',
        'e282', 'e28241', 'e282ac', 'f09f9880', 'f09f98', 'f09f9841', '61e282ac62f09f988063', 'eda0bdedb880',
    ]
    for h in fixed:
        cases.append(utf8_case(bytes.fromhex(h)))
    for _ in range(140):
        cases.append(utf8_case(rand_bytes(rnd.randint(1, 12))))
    for _ in range(140):
        cases.append(utf8_case(rand_text(rnd.randint(1, 20)).encode('utf-8')))
    # Valid text damaged at one position: a byte changed, removed or inserted, or the end cut off.
    for _ in range(220):
        data = bytearray(rand_text(rnd.randint(2, 16)).encode('utf-8'))
        how = rnd.randrange(4)
        at = rnd.randrange(len(data))
        if how == 0:
            data[at] = rnd.randrange(256)
        elif how == 1:
            del data[at]
        elif how == 2:
            data.insert(at, rnd.choice([0x80, 0xbf, 0xc0, 0xe0, 0xed, 0xf0, 0xf4, 0xf5, 0xff]))
        else:
            del data[at:]
        cases.append(utf8_case(bytes(data)))
    return cases


# Encodings ------------------------------------------------------------------------------------

def encoding_cases():
    cases = []
    lengths = list(range(0, 34)) + [rnd.randint(34, 400) for _ in range(60)]
    for n in lengths:
        data = rand_bytes(n)
        cases.append({
            'hex': data.hex(),
            'hexUpper': binascii.hexlify(data).decode().upper(),
            'base64': base64.b64encode(data).decode(),
            'base64url': base64.urlsafe_b64encode(data).decode(),
            'base64urlUnpadded': base64.urlsafe_b64encode(data).decode().rstrip('='),
            'percent': urllib.parse.quote(data, safe=''),
            'percentPlus': urllib.parse.quote_plus(data, safe=''),
        })
    for _ in range(60):
        text = rand_text(rnd.randint(1, 30))
        data = text.encode('utf-8')
        cases.append({
            'text': text,
            'hex': data.hex(),
            'hexUpper': data.hex().upper(),
            'base64': base64.b64encode(data).decode(),
            'base64url': base64.urlsafe_b64encode(data).decode(),
            'base64urlUnpadded': base64.urlsafe_b64encode(data).decode().rstrip('='),
            'percent': urllib.parse.quote(text, safe=''),
            'percentPlus': urllib.parse.quote_plus(text, safe=''),
        })
    return cases


STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def strict_base64(text):
    """Bytes if `text` is exactly what an RFC 4648 encoder emits (standard alphabet, padded), else None."""
    if not re.fullmatch(r'[A-Za-z0-9+/]*={0,2}', text) or len(text) % 4 != 0:
        return None
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None
    return data if base64.b64encode(data).decode() == text else None


def base64_strict_cases():
    """Encoded text, damaged in small ways. Strict decoding must accept exactly the canonical forms."""
    cases = []
    seen = set()

    def add(text):
        if text in seen:
            return
        seen.add(text)
        data = strict_base64(text)
        cases.append({'text': text, 'hex': None if data is None else data.hex()})

    for n in range(0, 10):
        for _ in range(6):
            good = base64.b64encode(rand_bytes(n)).decode()
            add(good)
            if not good:
                continue
            chars = list(good)
            at = rnd.randrange(len(chars))
            add(''.join(chars[:at] + [rnd.choice(STD + '=-_ .')] + chars[at + 1:]))
            add(good[:-1])
            add(good + '=')
            add(good + rnd.choice(STD))
            add(good.rstrip('='))
            add(''.join(chars[:at] + ['='] + chars[at:]))
            # Change the last data character: often leaves nonzero unused bits.
            body = good.rstrip('=')
            pad = good[len(body):]
            add(body[:-1] + rnd.choice(STD) + pad)
    return cases


def percent_decode_cases():
    """Well-formed percent-encoded text and the bytes it stands for."""
    cases = []
    for _ in range(80):
        data = rand_bytes(rnd.randint(0, 24))
        # Encode some bytes that do not need it, in either hex case, and leave others raw.
        parts = []
        for b in data:
            ch = chr(b)
            raw_ok = ch.isascii() and (ch.isalnum() or ch in '-._~!*\'();:@&=$,/?#[] ')
            if raw_ok and rnd.random() < 0.6:
                parts.append(ch)
            else:
                parts.append(('%%%02X' if rnd.random() < 0.5 else '%%%02x') % b)
        text = ''.join(parts)
        assert urllib.parse.unquote_to_bytes(text) == data
        cases.append({'text': text, 'hex': data.hex(), 'plusHex': urllib.parse.unquote_to_bytes(text.replace('+', ' ')).hex()})
    for _ in range(20):
        text = rand_text(rnd.randint(1, 10)) + '%41+%2B'
        cases.append({'text': text, 'hex': urllib.parse.unquote_to_bytes(text).hex(), 'plusHex': urllib.parse.unquote_to_bytes(text.replace('+', ' ')).hex()})
    return cases


# Digests --------------------------------------------------------------------------------------

def digest_cases():
    cases = []
    lengths = [0, 1, 2, 3, 55, 56, 57, 63, 64, 65, 111, 112, 113, 119, 120, 121, 127, 128, 129, 255, 256, 257, 1000, 4096, 65537]
    lengths += [rnd.randint(0, 600) for _ in range(40)]
    for n in lengths:
        data = rand_bytes(n)
        row = {'hex': data.hex()}
        for name, algo in (('MD5', 'md5'), ('SHA-1', 'sha1'), ('SHA-256', 'sha256'), ('SHA-384', 'sha384'), ('SHA-512', 'sha512')):
            d = hashlib.new(algo, data).digest()
            row[name] = {'hex': d.hex(), 'base64': base64.b64encode(d).decode()}
        cases.append(row)
    return cases


def hmac_cases():
    cases = []
    key_lengths = [1, 2, 16, 31, 32, 33, 63, 64, 65, 127, 128, 129, 200] + [rnd.randint(1, 300) for _ in range(27)]
    for kn in key_lengths:
        key = rand_bytes(kn)
        data = rand_bytes(rnd.randint(0, 300))
        row = {'key': key.hex(), 'data': data.hex()}
        for name, algo in (('SHA-256', hashlib.sha256), ('SHA-384', hashlib.sha384), ('SHA-512', hashlib.sha512)):
            row[name] = hmac.new(key, data, algo).hexdigest()
        cases.append(row)
    return cases


# UUIDs ----------------------------------------------------------------------------------------

def uuid_cases():
    cases = []
    for _ in range(200):
        raw = rand_bytes(16)
        u = uuid.UUID(bytes=raw)
        rfc = u.variant == uuid.RFC_4122
        cases.append({
            'text': str(u),
            'rfcVariant': rfc,
            'versionNibble': raw[6] >> 4,
            'version': u.version if rfc else None,
            'firstSixBytes': int.from_bytes(raw[:6], 'big'),
            'random': raw.hex(),
            'asV4': str(uuid.UUID(bytes=raw, version=4)),
        })
    return cases


# Text -----------------------------------------------------------------------------------------

def sort_cases():
    cases = []
    for _ in range(60):
        lines = [rand_text(rnd.randint(0, 6)) for _ in range(rnd.randint(1, 30))]
        # Repeats, so that deduplication has something to do.
        lines += [rnd.choice(lines) for _ in range(rnd.randint(0, 6))]
        rnd.shuffle(lines)
        first_seen = list(dict.fromkeys(lines))
        cases.append({'lines': lines, 'sorted': sorted(lines), 'sortedDescending': sorted(lines, reverse=True), 'deduped': first_seen})
    return cases


def fold_cases():
    """Case-insensitive sorting and deduplication over letters whose lowercase form is one character."""
    alphabet = 'abcXYZ' + ''.join(chr(c) for c in (0xc0, 0xe0, 0xc9, 0xe9, 0xd1, 0xf1, 0x391, 0x3b1, 0x3a9, 0x3c9, 0x416, 0x436)) + '12 _'
    cases = []
    for _ in range(40):
        lines = [''.join(rnd.choice(alphabet) for _ in range(rnd.randint(1, 4))) for _ in range(rnd.randint(1, 25))]
        lines += [l.swapcase() for l in lines[:5]]
        rnd.shuffle(lines)
        seen = set()
        deduped = []
        for l in lines:
            if l.lower() not in seen:
                seen.add(l.lower())
                deduped.append(l)
        cases.append({'lines': lines, 'sorted': sorted(lines, key=str.lower), 'deduped': deduped})
    return cases


def natural_cases():
    """Lines of the form letters, digits, letters; the reference orders them by (letters, value, digit count, letters)."""
    cases = []
    letters = 'abcXY'
    for _ in range(40):
        lines = []
        for _ in range(rnd.randint(2, 25)):
            prefix = ''.join(rnd.choice(letters) for _ in range(rnd.randint(1, 2)))
            digits = '0' * rnd.randint(0, 2) + str(rnd.choice([0, 1, 2, 9, 10, 11, 99, 100, 12345678901234567890123]))
            suffix = ''.join(rnd.choice(letters) for _ in range(rnd.randint(0, 2)))
            lines.append(prefix + digits + suffix)
        lines = list(dict.fromkeys(lines))

        def key(s):
            m = re.fullmatch(r'([A-Za-z]+)([0-9]+)([A-Za-z]*)', s)
            return (m.group(1), int(m.group(2)), len(m.group(2)), m.group(3))

        # The engine compares character by character, so a short prefix followed by digits sorts
        # before a longer prefix; the tuple order agrees because digits sort before letters.
        cases.append({'lines': lines, 'sorted': sorted(lines, key=key)})
    return cases


def stats_cases():
    cases = []
    spaces = [' ', ' ', '\t', chr(0xa0), chr(0x2003), chr(0x3000)]
    for _ in range(60):
        lines = []
        for _ in range(rnd.randint(0, 8)):
            words = [rand_text(rnd.randint(1, 5)).replace(' ', 'x').replace(chr(0xa0), 'y') for _ in range(rnd.randint(0, 5))]
            lines.append(rnd.choice(['', ' ']) + rnd.choice(spaces).join(words))
        eol = rnd.choice(['\n', '\r\n', '\r'])
        text = eol.join(lines) + (eol if lines and rnd.random() < 0.5 else '')
        parts = text.split(eol) if text else []
        if text.endswith(eol) and parts:
            parts = parts[:-1]
        cases.append({
            'text': text,
            'characters': len(text),
            'utf8Bytes': len(text.encode('utf-8')),
            'utf16Units': len(text.encode('utf-16-le')) // 2,
            'lines': len(parts),
            'words': len(text.split()),
            'longestLine': max((len(p) for p in parts), default=0),
            'uniqueLines': len(set(parts)),
            'emptyLines': sum(1 for p in parts if p.strip() == ''),
        })
    return cases


def main():
    data = {
        'generator': 'scripts/oracles/utils_oracle.py',
        'utf8': utf8_cases(),
        'encodings': encoding_cases(),
        'base64Strict': base64_strict_cases(),
        'percentDecode': percent_decode_cases(),
        'digests': digest_cases(),
        'hmacs': hmac_cases(),
        'uuids': uuid_cases(),
        'sorts': sort_cases(),
        'folds': fold_cases(),
        'naturals': natural_cases(),
        'stats': stats_cases(),
    }
    text = json.dumps(data, ensure_ascii=True, indent=None, separators=(',', ':'), sort_keys=True) + '\n'
    OUT.write_bytes(text.encode('ascii'))
    counts = ', '.join(f'{k} {len(v)}' for k, v in data.items() if isinstance(v, list))
    print(f'wrote {OUT.name}: {counts}; sha256 {hashlib.sha256(text.encode("ascii")).hexdigest()}')


if __name__ == '__main__':
    main()
