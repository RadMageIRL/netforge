#!/usr/bin/env python3
"""Reference values for Number Bases & Bytes and for mode strings, from the Python standard library.

  python scripts/oracles/tools5_oracle.py     (writes tests/fixtures/tools5-oracle.json)

Deterministic: fixed seeds, no clock. Python's int is the reference for base conversion and two's
complement (int.to_bytes / int.from_bytes), fractions.Fraction and decimal for storage units, and
stat.filemode for "ls -l" permission strings.
"""
import json
import os
import random
import stat
from decimal import Decimal, ROUND_HALF_UP, getcontext
from fractions import Fraction

getcontext().prec = 400
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'tests', 'fixtures', 'tools5-oracle.json')

WIDTHS = [1, 2, 3, 7, 8, 12, 16, 24, 31, 32, 33, 48, 63, 64, 65, 100, 128, 256, 1000, 4096]


def digits(value, base):
    """Non-negative int to digits in a base."""
    if value == 0:
        return '0'
    out = ''
    while value:
        out = '0123456789abcdef'[value % base] + out
        value //= base
    return out


def fixed_case(rng, width, signed, value):
    pattern = value % (1 << width)
    case = {
        'width': width, 'signed': signed, 'value': str(value),
        'unsigned': str(pattern),
        'signedReading': str(pattern - (1 << width) if pattern >> (width - 1) else pattern),
        'binary': digits(pattern, 2).rjust(width, '0'),
        'octal': digits(pattern, 8).rjust(-(-width // 3), '0'),
        'hex': digits(pattern, 16).rjust(-(-width // 4), '0'),
    }
    if width % 8 == 0:
        raw = value.to_bytes(width // 8, 'big', signed=signed)
        case['be'] = ['%02x' % b for b in raw]
        case['le'] = ['%02x' % b for b in value.to_bytes(width // 8, 'little', signed=signed)]
        assert int.from_bytes(raw, 'big', signed=signed) == value
    else:
        case['be'] = None
        case['le'] = None
    return case


def number_cases():
    rng = random.Random(5)
    fixed = []
    overflow = []
    for width in WIDTHS:
        for signed in (False, True):
            lo = -(1 << (width - 1)) if signed else 0
            hi = (1 << (width - 1)) - 1 if signed else (1 << width) - 1
            picks = {lo, hi, 0, min(hi, 1), max(lo, -1), lo + (1 if hi > lo else 0), hi - (1 if hi > lo else 0), (lo + hi) // 2}
            for _ in range(12 if width < 1000 else 2):
                picks.add(rng.randint(lo, hi))
            for value in sorted(picks):
                fixed.append(fixed_case(rng, width, signed, value))
            for value in (hi + 1, lo - 1, hi + rng.randint(2, 10 ** 6), lo - rng.randint(2, 10 ** 6), hi * 3 + 7):
                overflow.append({'width': width, 'signed': signed, 'value': str(value),
                                 'code': 'negative-unsigned' if (value < 0 and not signed) else 'overflow'})
            # A bit pattern one bit too wide, in each non-decimal base.
            too_wide = (1 << width) + rng.randint(0, (1 << width) - 1)
            overflow.append({'width': width, 'signed': signed, 'pattern': {'2': digits(too_wide, 2), '8': digits(too_wide, 8), '16': digits(too_wide, 16)}, 'code': 'overflow'})
    unbounded = []
    for bits in [0, 1, 7, 8, 9, 31, 32, 53, 54, 64, 65, 127, 128, 129, 255, 256, 257, 1000, 5000]:
        for _ in range(4 if bits < 1000 else 1):
            value = rng.getrandbits(bits) if bits else 0
            for v in (value, -value):
                mag = abs(v)
                raw = mag.to_bytes(max(1, (mag.bit_length() + 7) // 8), 'big')
                unbounded.append({
                    'value': str(v), 'binary': ('-' if v < 0 else '') + digits(mag, 2), 'octal': ('-' if v < 0 else '') + digits(mag, 8),
                    'hex': ('-' if v < 0 else '') + digits(mag, 16),
                    'be': None if v < 0 else ['%02x' % b for b in raw],
                    'unsignedBits': None if v < 0 else max(1, v.bit_length()),
                    'signedBits': (v.bit_length() if v >= 0 else (-v - 1).bit_length()) + 1,
                })
    return {'fixed': fixed, 'overflow': overflow, 'unbounded': unbounded}


UNITS = {'bit': 1, 'B': 8}
for i, (d, b) in enumerate(zip(['kB', 'MB', 'GB', 'TB', 'PB', 'EB'], ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'])):
    UNITS[d] = 8 * 1000 ** (i + 1)
    UNITS[b] = 8 * 1024 ** (i + 1)


def plain(d):
    text = format(d, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text or '0'


def exact_decimal(fr):
    return plain(Decimal(fr.numerator) / Decimal(fr.denominator))


def rounded(fr, significant):
    if fr == 0:
        return '0'
    d = Decimal(fr.numerator) / Decimal(fr.denominator)
    exponent = d.adjusted()
    quantum = Decimal(1).scaleb(exponent - significant + 1)
    return plain(d.quantize(quantum, rounding=ROUND_HALF_UP))


def unit_cases():
    rng = random.Random(11)
    amounts = ['0', '1', '8', '1.5', '.5', '0.125', '1000', '1024', '1536', '1.000', '0.1', '3.14159', '123456789012345678901234567890',
               '0.000001', '999.999', '5.', '7.0625', '1048576', '1000000000', '18446744073709551616', '0.3', '2.5', '100', '12.75', '0.0009765625']
    for _ in range(40):
        whole = str(rng.randint(0, 10 ** rng.randint(1, 20)))
        frac = ''.join(rng.choice('0123456789') for _ in range(rng.randint(0, 8)))
        amounts.append(whole + ('.' + frac if frac else ''))
    out = []
    for amount in amounts:
        for unit in rng.sample(sorted(UNITS), 5) + ['bit', 'B']:
            bits = Fraction(amount if not amount.startswith('.') else '0' + amount) * UNITS[unit] if not amount.endswith('.') else Fraction(amount[:-1]) * UNITS[unit]
            byte_count = bits / 8
            rows = {}
            for target, size in UNITS.items():
                value = bits / size
                rows[target] = {'exact': exact_decimal(value), 'rounded12': rounded(value, 12)}
            out.append({'amount': amount, 'from': unit, 'bits': [str(bits.numerator), str(bits.denominator)],
                        'wholeBytes': str(byte_count.numerator) if byte_count.denominator == 1 else None, 'rows': rows})
    return out


def mode_cases():
    out = []
    for mode in range(0o10000):
        out.append([mode, stat.filemode(stat.S_IFREG | mode)[1:], '%o' % mode])
    return out


def main():
    data = {'source': 'Python standard library (int, fractions, decimal, stat)', 'numbers': number_cases(), 'units': unit_cases(), 'modes': mode_cases()}
    with open(OUT, 'wb') as f:
        f.write(json.dumps(data, separators=(',', ':')).encode('ascii'))
        f.write(b'\n')
    n = data['numbers']
    print(len(n['fixed']), 'fixed-width,', len(n['overflow']), 'overflow,', len(n['unbounded']), 'unbounded,', len(data['units']), 'unit,', len(data['modes']), 'mode cases')


if __name__ == '__main__':
    main()
