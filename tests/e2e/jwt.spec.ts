import { createHmac, createPublicKey, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { grantClipboard, openTool, readClipboard, watchErrors } from './helpers';

// Tokens are made here with Node's OpenSSL and verified in the page by Chrome's Web Crypto
// (BoringSSL): two independent implementations must agree.
const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');
const SECRET = 'nf-e2e-shared-secret-0123456789-abcdef';

function unsigned(header: object, payload: object): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
}

function hs(alg: 'HS256' | 'HS384' | 'HS512', payload: object, secret: string | Buffer = SECRET, extra: object = {}): string {
  const input = unsigned({ alg, typ: 'JWT', ...extra }, payload);
  return `${input}.${createHmac(`sha${alg.slice(2)}`, secret).update(input).digest('base64url')}`;
}

function signed(alg: string, key: KeyObject, payload: object, extra: object = {}): string {
  const input = unsigned({ alg, typ: 'JWT', ...extra }, payload);
  const signer = createSign(`sha${alg.slice(2)}`).update(input);
  const signature = alg.startsWith('ES') ? signer.sign({ key, dsaEncoding: 'ieee-p1363' }) : signer.sign(key);
  return `${input}.${signature.toString('base64url')}`;
}

const pem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }) as string;
const now = () => Math.floor(Date.now() / 1000);
const claims = () => ({ iss: 'nf-issuer', sub: 'user-42', aud: ['api-one', 'api-two'], iat: now() - 60, nbf: now() - 60, exp: now() + 600, role: 'admin' });

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaOther = generateKeyPairSync('rsa', { modulusLength: 2048 });
const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
const p521 = generateKeyPairSync('ec', { namedCurve: 'P-521' });

async function verifyWithSecret(page: Page, secret: string): Promise<void> {
  await page.getByRole('radio', { name: 'Shared secret', exact: true }).check();
  await page.fill('#jwt-secret', secret);
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toBeVisible();
}

async function verifyWithPublic(page: Page, key: string): Promise<void> {
  await page.getByRole('radio', { name: 'Public key', exact: true }).check();
  await page.fill('#jwt-public', key);
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await openTool(page, 'jwt-decoder', 'JWT Decoder');
});

test('decodes header and claims and keeps the three states apart', async ({ page }) => {
  const errors = watchErrors(page);
  await expect(page.locator('#jwt-empty')).toBeVisible();
  await page.fill('#jwt-input', hs('HS256', claims()));
  await expect(page.locator('#jwt-header')).toHaveText('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
  await expect(page.locator('#jwt-payload')).toContainText('"iss": "nf-issuer"');
  await expect(page.locator('#jwt-alg')).toHaveText('Signature algorithm: HS256: HMAC with SHA-256 (a shared secret).');
  await expect(page.locator('#jwt-signature')).toContainText('32 bytes');
  await expect(page.locator('#jwt-state-decoded')).toHaveText('Decoded');
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: not verified');
  await expect(page.locator('#jwt-state-claims')).toHaveText('Claims: checked, no problems found');
  await expect(page.locator('#jwt-state-note')).toContainText('Anyone can write a token with any contents');
  await expect(page.locator('#jwt-empty')).toBeHidden();
  expect(errors).toEqual([]);
});

test('explains registered claims and shows times', async ({ page }) => {
  await page.fill('#jwt-input', hs('HS256', { iss: 'i', exp: 1900000000, iat: 1700000000, nbf: '1700000000', custom: { a: 1 } }));
  const row = (name: string) => page.locator(`#jwt-claim-table tr[data-claim="${name}"]`);
  await expect(row('exp')).toContainText('2030-03-17T17:46:40Z');
  await expect(row('exp')).toContainText('Expiration time');
  await expect(row('iat')).toContainText('2023-11-14T22:13:20Z');
  await expect(row('nbf')).toContainText('this is a string');
  await expect(row('custom')).toContainText('Not a registered claim');
  await expect(row('custom')).toContainText('{"a":1}');
  await expect(page.locator('#jwt-checks li[data-check="exp"]')).toHaveAttribute('data-outcome', 'pass');
  await expect(page.locator('#jwt-checks li[data-check="nbf"]')).toHaveAttribute('data-outcome', 'invalid');
  await expect(page.locator('#jwt-state-claims')).toHaveText('Claims: checked, problems found');
});

test('reports expired and not-yet-valid tokens, with a clock allowance', async ({ page }) => {
  await page.fill('#jwt-input', hs('HS256', { exp: now() - 30 }));
  await expect(page.locator('#jwt-checks li[data-check="exp"]')).toHaveAttribute('data-outcome', 'fail');
  await expect(page.locator('#jwt-checks li[data-check="exp"]')).toContainText('Expired');
  await expect(page.locator('#jwt-state-claims')).toHaveText('Claims: checked, problems found');
  await page.fill('#jwt-leeway', '300');
  await expect(page.locator('#jwt-checks li[data-check="exp"]')).toHaveAttribute('data-outcome', 'pass');
  await expect(page.locator('#jwt-checks li[data-check="exp"]')).toContainText('within the 300-second allowance');
  await page.fill('#jwt-leeway', '99999');
  await expect(page.locator('#jwt-leeway-error')).toContainText('0 to 3600');
  await page.fill('#jwt-leeway', '0');
  await page.fill('#jwt-input', hs('HS256', { nbf: now() + 3600, exp: now() + 7200 }));
  await expect(page.locator('#jwt-checks li[data-check="nbf"]')).toHaveAttribute('data-outcome', 'fail');
  await expect(page.locator('#jwt-checks li[data-check="nbf"]')).toContainText('Not valid yet');
  await page.fill('#jwt-input', hs('HS256', { sub: 'x' }));
  await expect(page.locator('#jwt-checks li[data-check="exp"]')).toHaveAttribute('data-outcome', 'absent');
  await expect(page.locator('#jwt-state-claims')).toHaveText('Claims: nothing checkable');
});

test('checks issuer and audience against expected values', async ({ page }) => {
  await page.fill('#jwt-input', hs('HS256', claims()));
  await page.fill('#jwt-issuer', 'nf-issuer');
  await page.fill('#jwt-audience', 'api-two');
  await expect(page.locator('#jwt-checks li[data-check="iss"]')).toHaveAttribute('data-outcome', 'pass');
  await expect(page.locator('#jwt-checks li[data-check="aud"]')).toHaveAttribute('data-outcome', 'pass');
  await page.fill('#jwt-issuer', 'NF-issuer');
  await expect(page.locator('#jwt-checks li[data-check="iss"]')).toHaveAttribute('data-outcome', 'fail');
  await page.fill('#jwt-audience', 'api-three');
  await expect(page.locator('#jwt-checks li[data-check="aud"]')).toHaveAttribute('data-outcome', 'fail');
  await expect(page.locator('#jwt-state-claims')).toHaveText('Claims: checked, problems found');
});

test('identifies malformed tokens', async ({ page }) => {
  const cases: [string, string, string][] = [
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0', 'segment-count', 'exactly three segments'],
    ['a.b.c.d.e', 'encrypted', 'encrypted token (JWE)'],
    [`${b64url('{"alg":"HS256"}')}=.${b64url('{}')}.`, 'segment-encoding', 'not valid unpadded Base64URL'],
    [`${b64url('{"alg":"HS256"')}.${b64url('{}')}.`, 'header-json', 'The header is not valid JSON'],
    [`${b64url('["HS256"]')}.${b64url('{}')}.`, 'header-not-object', 'rather than an object'],
    [`${b64url('{"typ":"JWT"}')}.${b64url('{}')}.`, 'alg-missing', 'no "alg" value'],
    [`${b64url('{"alg":"HS256","alg":"none"}')}.${b64url('{}')}.`, 'header-duplicate', 'repeats a name'],
    [`${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"a":1,}')}.`, 'payload-json', 'The payload is not valid JSON'],
    [`${b64url('{"alg":"HS256"}')}.${b64url('{"admin":false,"admin":true}')}.`, 'payload-duplicate', 'repeats a name'],
    [`${b64url('{"alg":"HS256"}')}.${b64url('{}')}\n.abc`, 'whitespace', 'contains whitespace'],
  ];
  for (const [token, code, message] of cases) {
    await page.fill('#jwt-input', token);
    await expect(page.locator('#jwt-input-error'), code).toContainText(message);
    await expect(page.locator('#jwt-input').locator('xpath=..')).toHaveAttribute('data-code', code);
    await expect(page.locator('#jwt-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#jwt-states')).toBeEmpty();
    await expect(page.locator('#jwt-header')).toHaveCount(0);
    await expect(page.locator('#jwt-verify')).toBeDisabled();
  }
});

test('verifies HS256, HS384 and HS512 with the shared secret, and fails with another', async ({ page }) => {
  for (const alg of ['HS256', 'HS384', 'HS512'] as const) {
    await page.fill('#jwt-input', hs(alg, claims()));
    await verifyWithSecret(page, SECRET);
    await expect(page.locator('#jwt-verify-message'), alg).toContainText(`Signature verified. The ${alg} signature matches`);
    await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: verified');
    await expect(page.locator('#jwt-state-note')).toContainText('does not show that the key belongs to the issuer you expect');
  }
  await verifyWithSecret(page, `${SECRET}x`);
  await expect(page.locator('#jwt-verify-message')).toContainText('Verification failed.');
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: verification failed');
  // Hex and Base64 forms of the same secret verify too.
  await page.getByRole('radio', { name: 'Hex', exact: true }).check();
  await page.fill('#jwt-secret', Buffer.from(SECRET).toString('hex'));
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toContainText('Signature verified.');
  await page.getByRole('radio', { name: 'Base64', exact: true }).check();
  await page.fill('#jwt-secret', Buffer.from(SECRET).toString('base64'));
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toContainText('Signature verified.');
});

test('a verified state never outlives the token or key it was computed for', async ({ page }) => {
  const token = hs('HS256', claims());
  await page.fill('#jwt-input', token);
  await verifyWithSecret(page, SECRET);
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: verified');
  // Change one character of the payload: the old result must disappear at once.
  const parts = token.split('.');
  const tampered = `${parts[0]}.${b64url(JSON.stringify({ ...claims(), role: 'root' }))}.${parts[2]}`;
  await page.fill('#jwt-input', tampered);
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: not verified');
  await expect(page.locator('#jwt-verify-message')).toHaveCount(0);
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toContainText('Verification failed.');
  await page.fill('#jwt-input', token);
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: verified');
  await page.fill('#jwt-secret', `${SECRET}-changed`);
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: not verified');
  await expect(page.locator('#jwt-verify-message')).toHaveCount(0);
});

test('verifies RS256, RS384 and RS512 with a PEM key and with a JWK', async ({ page }) => {
  for (const alg of ['RS256', 'RS384', 'RS512']) {
    await page.fill('#jwt-input', signed(alg, rsa.privateKey, claims()));
    await verifyWithPublic(page, pem(rsa.publicKey));
    await expect(page.locator('#jwt-verify-message'), alg).toContainText(`Signature verified. The ${alg} signature matches the header and payload for the PEM (SubjectPublicKeyInfo) you supplied.`);
  }
  await verifyWithPublic(page, JSON.stringify(rsa.publicKey.export({ format: 'jwk' })));
  await expect(page.locator('#jwt-verify-message')).toContainText('for the JWK (RSA) you supplied');
  await verifyWithPublic(page, rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }) as string);
  await expect(page.locator('#jwt-verify-message')).toContainText('Signature verified.');
  await verifyWithPublic(page, pem(rsaOther.publicKey));
  await expect(page.locator('#jwt-verify-message')).toContainText('Verification failed.');
});

test('verifies ES256, ES384 and ES512 in this browser', async ({ page }) => {
  const keys = { ES256: p256, ES384: p384, ES512: p521 };
  for (const [alg, pair] of Object.entries(keys)) {
    const token = signed(alg, pair.privateKey, claims());
    await page.fill('#jwt-input', token);
    await verifyWithPublic(page, pem(pair.publicKey));
    await expect(page.locator('#jwt-verify-message'), alg).toContainText(`Signature verified. The ${alg} signature matches`);
    await verifyWithPublic(page, JSON.stringify(pair.publicKey.export({ format: 'jwk' })));
    await expect(page.locator('#jwt-verify-message'), `${alg} JWK`).toContainText('Signature verified.');
    // A changed signature byte fails.
    const bytes = Buffer.from(token.split('.')[2], 'base64url');
    bytes[5] ^= 1;
    await page.fill('#jwt-input', `${token.split('.').slice(0, 2).join('.')}.${bytes.toString('base64url')}`);
    await page.locator('#jwt-verify').click();
    await expect(page.locator('#jwt-verify-message'), `${alg} tampered`).toContainText('Verification failed.');
  }
});

test('refuses algorithm confusion: a public key is never used as an HMAC secret', async ({ page }) => {
  // The attack: take an RS256 issuer's public key and sign an HS256 token with it as the secret.
  const publicPem = pem(rsa.publicKey);
  const forged = hs('HS256', { ...claims(), role: 'root' }, publicPem);
  await page.fill('#jwt-input', forged);
  await verifyWithPublic(page, publicPem);
  await expect(page.locator('#jwt-verify-message')).toHaveAttribute('data-code', 'key-type-mismatch');
  await expect(page.locator('#jwt-verify-message')).toContainText('never with a public key');
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: not verified (could not check)');
  // Offering the same PEM as the "secret" is refused too, in every encoding.
  await page.getByRole('radio', { name: 'Shared secret', exact: true }).check();
  await page.getByRole('radio', { name: 'Base64', exact: true }).check();
  await page.fill('#jwt-secret', Buffer.from(publicPem).toString('base64'));
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toHaveAttribute('data-code', 'key-confusion');
  await expect(page.locator('#jwt-verify-message')).toContainText('algorithm confusion');
  await expect(page.locator('#jwt-state-signature')).not.toHaveText('Signature: verified');
});

test('rejects key-type and curve mismatches, private keys and unsupported input', async ({ page }) => {
  const expectCode = async (code: string) => { await expect(page.locator('#jwt-verify-message')).toHaveAttribute('data-code', code); };
  await page.fill('#jwt-input', signed('RS256', rsa.privateKey, claims()));
  await verifyWithSecret(page, SECRET);
  await expectCode('key-type-mismatch');
  await verifyWithPublic(page, pem(p256.publicKey));
  await expectCode('key-type-mismatch');
  await verifyWithPublic(page, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  await expectCode('key-private');
  await expect(page.locator('#jwt-verify-message')).toContainText('This is a private key');
  await verifyWithPublic(page, JSON.stringify(rsa.privateKey.export({ format: 'jwk' })));
  await expectCode('key-private');
  await verifyWithPublic(page, 'https://issuer.example/.well-known/jwks.json');
  await expectCode('key-format');
  await expect(page.locator('#jwt-verify-message')).toContainText('never fetches keys');
  await verifyWithPublic(page, JSON.stringify({ ...rsa.publicKey.export({ format: 'jwk' }), use: 'enc' }));
  await expectCode('key-use');
  await verifyWithPublic(page, JSON.stringify({ ...rsa.publicKey.export({ format: 'jwk' }), alg: 'RS512' }));
  await expectCode('key-alg');

  await page.fill('#jwt-input', signed('ES256', p256.privateKey, claims()));
  await verifyWithPublic(page, pem(p384.publicKey));
  await expectCode('curve-mismatch');
  await verifyWithPublic(page, pem(rsa.publicKey));
  await expectCode('key-type-mismatch');
  // A DER-encoded ECDSA signature is the wrong shape for a JWT.
  const input = unsigned({ alg: 'ES256', typ: 'JWT' }, claims());
  const der = createSign('sha256').update(input).sign(p256.privateKey);
  await page.fill('#jwt-input', `${input}.${der.toString('base64url')}`);
  await verifyWithPublic(page, pem(p256.publicKey));
  await expectCode('signature-malformed');

  const ed = generateKeyPairSync('ed25519');
  await verifyWithPublic(page, pem(ed.publicKey));
  await expectCode('key-unsupported');
  await verifyWithPublic(page, pem(createPublicKey(generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey)));
  await expectCode('key-unsupported');
});

test('never verifies unsecured or unsupported algorithms, and ignores keys named by the token', async ({ page }) => {
  await page.fill('#jwt-input', `${unsigned({ alg: 'none', typ: 'JWT' }, claims())}.`);
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: none (unsecured token)');
  await expect(page.locator('#jwt-alg')).toContainText('no signature at all');
  await verifyWithSecret(page, SECRET);
  await expect(page.locator('#jwt-verify-message')).toHaveAttribute('data-code', 'alg-none');
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: none (unsecured token)');

  await page.fill('#jwt-input', `${unsigned({ alg: 'PS256', typ: 'JWT' }, claims())}.${b64url(Buffer.alloc(256))}`);
  await verifyWithPublic(page, pem(rsa.publicKey));
  await expect(page.locator('#jwt-verify-message')).toHaveAttribute('data-code', 'alg-unsupported');
  await page.fill('#jwt-input', hs('HS256', claims(), SECRET, { alg: 'hs256' }));
  await expect(page.locator('#jwt-alg')).toContainText('Names are case-sensitive');

  await page.fill('#jwt-input', hs('HS256', claims(), SECRET, { jku: 'https://attacker.example/keys.json', crit: ['exp'] }));
  await expect(page.locator('#jwt-notes')).toContainText('NetForge never fetches it');
  await verifyWithSecret(page, SECRET);
  await expect(page.locator('#jwt-verify-message')).toHaveAttribute('data-code', 'critical-header');
});

test('picks the key from a pasted JWK Set by kid', async ({ page }) => {
  const set = { keys: [{ ...rsaOther.publicKey.export({ format: 'jwk' }), kid: 'old' }, { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'current' }] };
  await page.fill('#jwt-input', signed('RS256', rsa.privateKey, claims(), { kid: 'current' }));
  await verifyWithPublic(page, JSON.stringify(set));
  await expect(page.locator('#jwt-verify-message')).toContainText('Signature verified.');
  await page.fill('#jwt-input', signed('RS256', rsa.privateKey, claims(), { kid: 'missing' }));
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toHaveAttribute('data-code', 'key-not-found');
});

test('warns about a weak secret while still reporting the result', async ({ page }) => {
  await page.fill('#jwt-input', hs('HS256', claims(), 'short'));
  await verifyWithSecret(page, 'short');
  await expect(page.locator('#jwt-verify-message')).toContainText('Signature verified.');
  await expect(page.locator('#jwt-verify-warnings')).toContainText('The secret is 5 bytes');
});

test('the Example token is valid now and verifies; copy gives the payload', async ({ page, context }) => {
  await grantClipboard(context);
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('#jwt-state-claims')).toHaveText('Claims: checked, no problems found');
  await page.locator('#jwt-verify').click();
  await expect(page.locator('#jwt-verify-message')).toContainText('Signature verified.');
  await page.getByRole('button', { name: 'Copy payload' }).click();
  expect(JSON.parse(await readClipboard(page))).toMatchObject({ iss: 'netforge-example', scope: 'read:reports' });
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#jwt-input')).toHaveValue('');
  await expect(page.locator('#jwt-secret')).toHaveValue('');
  await expect(page.locator('#jwt-states')).toBeEmpty();
});

test('tokens and keys are never stored, never put in the address and gone after a reload', async ({ page }) => {
  const token = hs('HS256', { ...claims(), sub: 'nf-sentinel-subject' }, 'nf-sentinel-secret-nf-sentinel-secret');
  await page.fill('#jwt-input', token);
  await verifyWithSecret(page, 'nf-sentinel-secret-nf-sentinel-secret');
  await expect(page.locator('#jwt-state-signature')).toHaveText('Signature: verified');
  expect(page.url()).toMatch(/#\/jwt-decoder$/);
  const state = await page.evaluate(async () => ({
    stored: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie,
    keys: Object.keys(localStorage).sort(),
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    history: history.length,
  }));
  expect(state.stored).not.toContain('nf-sentinel');
  expect(state.stored).not.toContain(token.split('.')[2]);
  expect(state.keys).toEqual(['netforge.lastTool']);
  expect([state.databases, state.caches]).toEqual([0, 0]);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'JWT Decoder' })).toBeVisible();
  await expect(page.locator('#jwt-input')).toHaveValue('');
  await expect(page.locator('#jwt-secret')).toHaveValue('');
  await expect(page.locator('#jwt-public')).toHaveValue('');
});
