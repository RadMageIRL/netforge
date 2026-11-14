#!/usr/bin/env python3
"""Independent reference for JWT signature verification.

Writes tests/fixtures/jwt-oracle.json: tokens signed by the OpenSSL command line (RSA and ECDSA)
and by Python's hmac module (HS256/384/512), with the PUBLIC keys and expected outcomes. The unit
suite then verifies every case through the Web Crypto API, so signatures made by one program are
checked by another.

Needs: Python 3.9+ (standard library only) and the openssl command (3.x). Set OPENSSL to its path
if it is not on PATH.

    python scripts/oracles/jwt_oracle.py

Not byte-reproducible: key generation is random and ECDSA signatures are randomized, so every run
writes different keys and tokens. The committed fixture is one such run; the cases and expected
outcomes are the same on every run.

Private keys are created in a temporary directory outside the repository and deleted before the
script exits. Only public keys, test-only HMAC secrets and tokens are written to the fixture.
"""
import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tests' / 'fixtures' / 'jwt-oracle.json'
OPENSSL = os.environ.get('OPENSSL') or shutil.which('openssl')

HASHES = {'256': 'sha256', '384': 'sha384', '512': 'sha512'}
CURVES = {'ES256': 'P-256', 'ES384': 'P-384', 'ES512': 'P-521'}
COORDINATE_BYTES = {'P-256': 32, 'P-384': 48, 'P-521': 66}
# Test-only secrets. Each is at least as long as the largest HMAC output (64 bytes).
SECRET = b'netforge-oracle-shared-secret/0123456789abcdef0123456789abcdef0123456789abcdef'
OTHER_SECRET = b'netforge-oracle-another-secret/fedcba9876543210fedcba9876543210fedcba9876543210'
CLAIMS = {'iss': 'https://issuer.example', 'sub': 'oracle-user', 'aud': 'netforge-tests', 'iat': 1700000000, 'exp': 2000000000}


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def run(*args: str, stdin: bytes | None = None) -> bytes:
    done = subprocess.run([OPENSSL, *args], input=stdin, capture_output=True)
    if done.returncode != 0:
        raise SystemExit(f'openssl {" ".join(args)} failed:\n{done.stderr.decode(errors="replace")}')
    return done.stdout


# --- A minimal DER reader, enough for SubjectPublicKeyInfo and ECDSA signatures ----------------

def tlv(data: bytes, at: int) -> tuple[int, int, int]:
    """Returns (tag, content start, content end) of the element at `at`."""
    tag = data[at]
    length = data[at + 1]
    start = at + 2
    if length & 0x80:
        count = length & 0x7f
        length = int.from_bytes(data[start:start + count], 'big')
        start += count
    return tag, start, start + length


def children(data: bytes, start: int, end: int) -> list[tuple[int, int, int]]:
    out = []
    at = start
    while at < end:
        item = tlv(data, at)
        out.append(item)
        at = item[2]
    return out


def unsigned(data: bytes) -> bytes:
    return data.lstrip(b'\x00') or b'\x00'


def pem_to_der(pem: str) -> bytes:
    body = ''.join(line for line in pem.strip().splitlines() if not line.startswith('-----'))
    return base64.b64decode(body)


def jwk_from_spki(pem: str, curve: str | None) -> dict:
    """Builds a public JWK from the key parameters inside a SubjectPublicKeyInfo PEM."""
    der = pem_to_der(pem)
    _, s, e = tlv(der, 0)
    _algorithm, bit_string = children(der, s, e)
    key = der[bit_string[1] + 1:bit_string[2]]  # skip the unused-bits byte
    if curve is None:
        _, s2, e2 = tlv(key, 0)
        modulus, exponent = children(key, s2, e2)
        return {'kty': 'RSA', 'n': b64u(unsigned(key[modulus[1]:modulus[2]])), 'e': b64u(unsigned(key[exponent[1]:exponent[2]]))}
    size = COORDINATE_BYTES[curve]
    assert key[0] == 4 and len(key) == 1 + 2 * size, 'expected an uncompressed point'
    return {'kty': 'EC', 'crv': curve, 'x': b64u(key[1:1 + size]), 'y': b64u(key[1 + size:])}


def ecdsa_der_to_raw(der: bytes, size: int) -> bytes:
    """ASN.1 SEQUENCE { r INTEGER, s INTEGER } to the fixed-width r || s that JWS uses."""
    _, s, e = tlv(der, 0)
    r, s_value = children(der, s, e)
    return b''.join(int.from_bytes(der[a:b], 'big').to_bytes(size, 'big') for (_, a, b) in (r, s_value))


class Keys:
    def __init__(self, work: Path):
        self.work = work
        self.private: dict[str, Path] = {}
        self.public_pem: dict[str, str] = {}
        self.jwk: dict[str, dict] = {}

    def make(self, name: str, *genpkey: str, curve: str | None = None) -> None:
        path = self.work / f'{name}.private'
        run('genpkey', *genpkey, '-out', str(path))
        self.private[name] = path
        self.public_pem[name] = run('pkey', '-in', str(path), '-pubout').decode('ascii').replace('\r\n', '\n')
        self.jwk[name] = jwk_from_spki(self.public_pem[name], curve)

    def pkcs1(self, name: str) -> str:
        return run('rsa', '-in', str(self.private[name]), '-RSAPublicKey_out').decode('ascii').replace('\r\n', '\n')

    def sign(self, name: str, digest: str, data: bytes) -> bytes:
        return run('dgst', f'-{digest}', '-sign', str(self.private[name]), stdin=data)


def main() -> None:
    if not OPENSSL:
        raise SystemExit('openssl was not found. Put it on PATH or set OPENSSL to its full path.')
    version = run('version').decode('ascii').strip()
    work = Path(tempfile.mkdtemp(prefix='netforge-jwt-oracle-'))
    if ROOT in work.resolve().parents or work.resolve() == ROOT:
        shutil.rmtree(work, ignore_errors=True)
        raise SystemExit('The temporary directory is inside the repository; refusing to write private keys there.')
    cases: list[dict] = []
    try:
        keys = Keys(work)
        keys.make('rsa', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048')
        keys.make('rsa-other', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048')
        for curve in ('P-256', 'P-384', 'P-521'):
            keys.make(curve, '-algorithm', 'EC', '-pkeyopt', f'ec_paramgen_curve:{curve}', curve=curve)
            keys.make(f'{curve}-other', '-algorithm', 'EC', '-pkeyopt', f'ec_paramgen_curve:{curve}', curve=curve)

        def signing_input(alg: str, claims: dict | None = None, **header_extra) -> str:
            header = {'alg': alg, 'typ': 'JWT', **header_extra}
            return b64u(json.dumps(header, separators=(',', ':')).encode()) + '.' + b64u(json.dumps(claims or CLAIMS, separators=(',', ':')).encode())

        def signature(alg: str, data: str, key_name: str | None = None, secret: bytes = SECRET, digest: str | None = None, der: bool = False) -> bytes:
            digest = digest or HASHES[alg[2:]]
            if alg.startswith('HS'):
                return hmac.new(secret, data.encode(), getattr(hashlib, digest)).digest()
            if alg.startswith('RS'):
                return keys.sign(key_name or 'rsa', digest, data.encode())
            curve = CURVES[alg]
            made = keys.sign(key_name or curve, digest, data.encode())
            return made if der else ecdsa_der_to_raw(made, COORDINATE_BYTES[curve])

        def token(alg: str, **kw) -> str:
            data = signing_input(alg, kw.pop('claims', None), **kw.pop('header', {}))
            return data + '.' + b64u(signature(alg, data, **kw))

        def public(text) -> dict:
            return {'kind': 'public', 'text': text if isinstance(text, str) else json.dumps(text, separators=(',', ':'))}

        def secret_key(value: bytes, form: str = 'hex') -> dict:
            text = {'hex': value.hex(), 'base64': base64.b64encode(value).decode(), 'base64url': b64u(value), 'text': value.decode('utf-8')}[form]
            return {'kind': 'secret', 'format': 'base64' if form == 'base64url' else form, 'text': text}

        def add(name: str, tok: str, key: dict, expect: str) -> None:
            cases.append({'name': name, 'token': tok, 'key': key, 'expect': expect})

        def tamper_payload(tok: str) -> str:
            h, _, s = tok.split('.')
            changed = dict(CLAIMS, sub='administrator')
            return h + '.' + b64u(json.dumps(changed, separators=(',', ':')).encode()) + '.' + s

        def tamper_signature(tok: str) -> str:
            h, p, s = tok.split('.')
            raw = bytearray(unb64u(s))
            raw[len(raw) // 2] ^= 0x04
            return h + '.' + p + '.' + b64u(bytes(raw))

        # HMAC: signed by Python's hmac.
        for alg in ('HS256', 'HS384', 'HS512'):
            tok = token(alg)
            for form in (('hex', 'base64', 'base64url', 'text') if alg == 'HS256' else ('hex',)):
                add(f'{alg} valid, secret as {form}', tok, secret_key(SECRET, form), 'verified')
            add(f'{alg} wrong secret', tok, secret_key(OTHER_SECRET), 'failed')
            add(f'{alg} changed payload', tamper_payload(tok), secret_key(SECRET), 'failed')
            add(f'{alg} changed signature', tamper_signature(tok), secret_key(SECRET), 'failed')
            if alg == 'HS256':
                add(f'{alg} token checked with a public key', tok, public(keys.public_pem['rsa']), 'key-type-mismatch')

        # RSA: signed by openssl dgst -sign (RSASSA-PKCS1-v1_5).
        for alg in ('RS256', 'RS384', 'RS512'):
            tok = token(alg)
            add(f'{alg} valid, SubjectPublicKeyInfo PEM', tok, public(keys.public_pem['rsa']), 'verified')
            if alg == 'RS256':
                add(f'{alg} valid, PKCS#1 PEM', tok, public(keys.pkcs1('rsa')), 'verified')
                add(f'{alg} wrong key, JWK', tok, public(keys.jwk['rsa-other']), 'failed')
                add(f'{alg} token checked with an EC key', tok, public(keys.public_pem['P-256']), 'key-type-mismatch')
                add(f'{alg} token checked with a shared secret', tok, secret_key(SECRET), 'key-type-mismatch')
            add(f'{alg} valid, JWK', tok, public(keys.jwk['rsa']), 'verified')
            add(f'{alg} wrong key', tok, public(keys.public_pem['rsa-other']), 'failed')
            add(f'{alg} changed payload', tamper_payload(tok), public(keys.public_pem['rsa']), 'failed')
            add(f'{alg} changed signature', tamper_signature(tok), public(keys.jwk['rsa']), 'failed')

        # ECDSA: signed by openssl dgst -sign, converted from DER to r || s here.
        for alg, curve in CURVES.items():
            tok = token(alg)
            add(f'{alg} valid, SubjectPublicKeyInfo PEM', tok, public(keys.public_pem[curve]), 'verified')
            add(f'{alg} valid, JWK', tok, public(keys.jwk[curve]), 'verified')
            add(f'{alg} wrong key', tok, public(keys.public_pem[f'{curve}-other']), 'failed')
            add(f'{alg} changed payload', tamper_payload(tok), public(keys.jwk[curve]), 'failed')
            add(f'{alg} changed signature', tamper_signature(tok), public(keys.public_pem[curve]), 'failed')
            add(f'{alg} signature left in ASN.1 DER form', token(alg, der=True), public(keys.public_pem[curve]), 'signature-malformed')
            add(f'{alg} token checked with an RSA key', tok, public(keys.jwk['rsa']), 'key-type-mismatch')
            other_curve = {'P-256': 'P-384', 'P-384': 'P-521', 'P-521': 'P-256'}[curve]
            add(f'{alg} token checked with a {other_curve} key', tok, public(keys.public_pem[other_curve]), 'curve-mismatch')
            if alg == 'ES256':
                add(f'{alg} token checked with a {other_curve} JWK', tok, public(keys.jwk[other_curve]), 'curve-mismatch')
                add(f'{alg} wrong key, JWK', tok, public(keys.jwk[f'{curve}-other']), 'failed')

        # The hash is bound to the algorithm name.
        data = signing_input('RS256')
        add('RS256 header over a SHA-384 signature', data + '.' + b64u(signature('RS256', data, digest='sha384')), public(keys.public_pem['rsa']), 'failed')
        data = signing_input('ES256')
        add('ES256 header over a SHA-384 signature', data + '.' + b64u(signature('ES256', data, digest='sha384')), public(keys.public_pem['P-256']), 'failed')

        # Algorithm confusion: HS256 keyed with the bytes of the RSA public key PEM.
        pem = keys.public_pem['rsa']
        forged = token('HS256', secret=pem.encode('ascii'), claims=dict(CLAIMS, sub='administrator'))
        add('confusion: forged HS256 token, public key given as a public key', forged, public(pem), 'key-type-mismatch')
        add('confusion: forged HS256 token, public key given as a JWK', forged, public(keys.jwk['rsa']), 'key-type-mismatch')
        add('confusion: forged HS256 token, PEM given as the secret text', forged, secret_key(pem.encode('ascii'), 'text'), 'key-confusion')
        add('confusion: forged HS256 token, PEM given as the secret in hex', forged, secret_key(pem.encode('ascii'), 'hex'), 'key-confusion')
        add('confusion: forged HS256 token, PEM given as the secret in Base64', forged, secret_key(pem.encode('ascii'), 'base64'), 'key-confusion')

        # Tokens that must be refused before any key is looked at.
        unsigned_token = b64u(b'{"alg":"none"}') + '.' + b64u(json.dumps(CLAIMS, separators=(',', ':')).encode()) + '.'
        add('alg none with a secret', unsigned_token, secret_key(SECRET), 'alg-none')
        add('alg none with a public key', unsigned_token, public(pem), 'alg-none')
        add('crit header on a correctly signed token', token('RS256', header={'crit': ['exp'], 'exp': 2000000000}), public(pem), 'critical-header')
        data = b64u(b'{"alg":"PS256"}') + '.' + b64u(b'{}')
        add('PS256 is not supported', data + '.' + b64u(signature('RS256', data)), public(pem), 'alg-unsupported')

        # A JWK that says it is for something else.
        tok = token('RS256')
        add('JWK marked for encryption', tok, public(dict(keys.jwk['rsa'], use='enc')), 'key-use')
        add('JWK restricted to RS512', tok, public(dict(keys.jwk['rsa'], alg='RS512')), 'key-alg')
        add('JWK marked for signatures and RS256', tok, public(dict(keys.jwk['rsa'], use='sig', alg='RS256', key_ops=['verify'])), 'verified')

        # Key chosen from a pasted JWK Set by the token's kid.
        key_set = {'keys': [dict(keys.jwk['rsa-other'], kid='previous'), dict(keys.jwk['rsa'], kid='current'), dict(keys.jwk['P-256'], kid='ec')]}
        add('JWK Set: kid names the signing key', token('RS256', header={'kid': 'current'}), public(key_set), 'verified')
        add('JWK Set: kid names another key', token('RS256', header={'kid': 'previous'}), public(key_set), 'failed')
        add('JWK Set: kid names no key', token('RS256', header={'kid': 'missing'}), public(key_set), 'key-not-found')
        add('JWK Set: EC key chosen by kid', token('ES256', header={'kid': 'ec'}), public(key_set), 'verified')
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if work.exists():
        raise SystemExit(f'Could not delete {work}; remove it by hand: it holds private keys.')

    fixture = {
        'generator': 'scripts/oracles/jwt_oracle.py',
        'signedBy': f'{version}; Python {sys.version_info.major}.{sys.version_info.minor} hmac',
        'note': 'Keys are random and ECDSA signatures are randomized, so regenerating this file changes every token. Only public keys and test-only HMAC secrets are stored.',
        'cases': cases,
    }
    text = json.dumps(fixture, indent=1, sort_keys=True) + '\n'
    assert 'PRIVATE' not in text, 'a private key must never reach the fixture'
    OUT.write_bytes(text.encode('utf-8'))
    counts: dict[str, int] = {}
    for case in cases:
        counts[case['expect']] = counts.get(case['expect'], 0) + 1
    print(f'wrote {OUT.relative_to(ROOT)}: {len(cases)} cases, {counts}')


if __name__ == '__main__':
    main()
