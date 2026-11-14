/**
 * JWT Decoder: reads a token's header and claims, explains them, checks the time claims against
 * this device's clock, and can verify the signature with a key you supply.
 *
 * Three separate facts are shown and never merged: the token was decoded; its signature was (or
 * was not) verified with your key; its claims were (or were not) checked. None of them means the
 * token is authorized or trustworthy. Tokens and keys stay in memory on this page: they are never
 * stored, never put in the address bar and never sent anywhere, and no key is ever fetched.
 */
import { checkClaims, claimsVerdict, describeClaims, MAX_LEEWAY_SECONDS, type ClaimCheck } from '../../core/jwt/claims';
import { decodeJwt, unsupportedAlgReason, type DecodedJwt } from '../../core/jwt/jwt';
import type { SecretFormat } from '../../core/jwt/keys';
import { verifyJwt, type KeyInput, type VerifyOutcome } from '../../core/jwt/verify';
import { base64Encode, hexEncode } from '../../core/codec/codec';
import { formatByteSize } from '../../core/format';
import type { ToolMeta, ToolServices } from '../../app/registry';
import { button, copyButton, notice, panel, segmented, textArea, textField, toolPage } from '../../ui/components';
import { h, replaceChildren, type Child } from '../../ui/dom';
import { icon, type IconName } from '../../ui/icons';
import { codeBlock, goToOffset, noteList, numberField, section } from '../util-shared/util-view';

type KeyKind = 'secret' | 'public';

const EXAMPLE_SECRET = 'netforge-example-secret-do-not-use-for-anything-real';

function badge(kind: 'ok' | 'error' | 'warning' | 'info', text: string, id: string): HTMLElement {
  const name: IconName = kind === 'ok' ? 'ok' : kind;
  return h('span', { class: `badge badge-${kind} state-badge`, id }, icon(name), text);
}

const CHECK_ICON: Readonly<Record<ClaimCheck['outcome'], { kind: 'ok' | 'error' | 'warning' | 'info'; word: string }>> = {
  pass: { kind: 'ok', word: 'Pass' },
  fail: { kind: 'error', word: 'Fail' },
  invalid: { kind: 'error', word: 'Malformed' },
  absent: { kind: 'warning', word: 'Absent' },
  note: { kind: 'info', word: 'Note' },
};

export function mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): { activate(): void } {
  let decoded: DecodedJwt | null = null;
  let keyKind: KeyKind = 'secret';
  let secretFormat: SecretFormat = 'text';
  /** The outcome of the last verification, valid only for exactly the token and key it ran on. */
  let verification: VerifyOutcome | null = null;
  let verifyRun = 0;

  const tokenField = textArea({ id: 'jwt-input', label: 'Token', hideLabel: true, mono: true, rows: 6, placeholder: 'Paste a JSON Web Token (three parts separated by dots)' });
  const token = tokenField.control;
  token.setAttribute('wrap', 'soft');
  token.classList.add('token-area');

  const states = h('div', { class: 'state-row', id: 'jwt-states', role: 'status' });
  const stateNote = h('p', { class: 'source-note', id: 'jwt-state-note' });
  const decodedArea = h('div', { class: 'result-area', id: 'jwt-decoded' });
  const claimArea = h('div', { class: 'result-area', id: 'jwt-claims' });
  const verifyResult = h('div', { id: 'jwt-verify-result', role: 'status' });
  const gotoButton = h('button', { type: 'button', class: 'btn btn-secondary', id: 'jwt-goto', hidden: true }, 'Go to position');
  const emptyNote = h('p', { class: 'muted', id: 'jwt-empty' }, 'Paste a token to see its header and claims. Decoding happens on this device.');

  const leeway = numberField({ id: 'jwt-leeway', label: 'Clock allowance (seconds)', value: '0', hint: `0 to ${MAX_LEEWAY_SECONDS}. Applied to exp and nbf.`, onInput: () => renderClaims() });
  const issuer = textField({ id: 'jwt-issuer', label: 'Expected issuer (optional)', mono: true, placeholder: 'Compared exactly with iss' });
  const audience = textField({ id: 'jwt-audience', label: 'Expected audience (optional)', mono: true, placeholder: 'Must be, or be listed in, aud' });

  const secretField = textField({ id: 'jwt-secret', label: 'Shared secret', mono: true, placeholder: 'The secret the token was signed with',
    hint: 'For HS256, HS384 and HS512. Used on this device only; never stored.' });
  const secretFormatControl = segmented({
    label: 'Secret is', name: 'jwt-secret-format', value: secretFormat,
    choices: [{ value: 'text', label: 'Text (UTF-8)' }, { value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }],
    onChange: value => { secretFormat = value as SecretFormat; resetVerification(); },
  });
  const publicField = textArea({ id: 'jwt-public', label: 'Public key', mono: true, rows: 7, placeholder: '-----BEGIN PUBLIC KEY-----  or  {"kty": "RSA", ...}',
    hint: 'For RS256/384/512 and ES256/384/512: a PEM public key, a JWK, or a JWK Set you have copied. Paste the public key only; private keys are refused. NetForge never downloads keys.' });
  const secretRow = h('div', { class: 'controls-row', id: 'jwt-secret-row' }, secretField.root, secretFormatControl.root);
  const publicRow = h('div', { id: 'jwt-public-row', hidden: true }, publicField.root);
  const keyKindControl = segmented({
    label: 'Verify with', name: 'jwt-key-kind', value: keyKind,
    choices: [{ value: 'secret', label: 'Shared secret' }, { value: 'public', label: 'Public key' }],
    onChange: value => {
      keyKind = value as KeyKind;
      secretRow.hidden = keyKind !== 'secret';
      publicRow.hidden = keyKind !== 'public';
      resetVerification();
    },
  });

  const keyInput = (): KeyInput => (keyKind === 'secret'
    ? { kind: 'secret', text: secretField.control.value, format: secretFormat }
    : { kind: 'public', text: publicField.control.value });

  const verifyButton = button({ label: 'Verify signature', variant: 'primary', id: 'jwt-verify', onClick: () => { void verify(); } });

  function signatureBadge(): HTMLElement {
    if (!decoded) return badge('info', 'Signature: not verified', 'jwt-state-signature');
    if (decoded.alg === 'none') return badge('warning', 'Signature: none (unsecured token)', 'jwt-state-signature');
    if (!verification) return badge('info', 'Signature: not verified', 'jwt-state-signature');
    if (verification.status === 'verified') return badge('ok', 'Signature: verified', 'jwt-state-signature');
    if (verification.status === 'failed') return badge('error', 'Signature: verification failed', 'jwt-state-signature');
    return badge('warning', 'Signature: not verified (could not check)', 'jwt-state-signature');
  }

  function currentChecks(): ClaimCheck[] | null {
    if (!decoded?.claims) return null;
    const seconds = /^\d{1,4}$/.test(leeway.control.value.trim()) ? Number(leeway.control.value.trim()) : NaN;
    if (!(seconds >= 0 && seconds <= MAX_LEEWAY_SECONDS)) {
      leeway.setError(`Enter a whole number of seconds from 0 to ${MAX_LEEWAY_SECONDS}.`);
      return null;
    }
    leeway.setError(null);
    return checkClaims(decoded.claims, { nowMs: Date.now(), leewaySeconds: seconds, expectedIssuer: issuer.control.value, expectedAudience: audience.control.value });
  }

  function renderStates(checks: ClaimCheck[] | null): void {
    if (!decoded) {
      replaceChildren(states);
      stateNote.textContent = '';
      return;
    }
    const verdict = checks ? claimsVerdict(checks) : 'none';
    const claimsBadge = !decoded.claims
      ? badge('info', 'Claims: none to check (not a JWT claims set)', 'jwt-state-claims')
      : verdict === 'pass' ? badge('ok', 'Claims: checked, no problems found', 'jwt-state-claims')
        : verdict === 'fail' ? badge('error', 'Claims: checked, problems found', 'jwt-state-claims')
          : badge('info', 'Claims: nothing checkable', 'jwt-state-claims');
    replaceChildren(states, badge('ok', 'Decoded', 'jwt-state-decoded'), signatureBadge(), claimsBadge);
    stateNote.textContent = verification?.status === 'verified'
      ? 'Verified means the signature was made with the key you supplied. It does not show that the key belongs to the issuer you expect, that the token was meant for you, or that it grants anything: the system that accepts the token must decide that.'
      : 'Decoding only reads the token. Anyone can write a token with any contents, so nothing shown here can be trusted until the signature is verified with a key you already trust, and even then it proves only who signed it.';
  }

  function renderDecoded(): void {
    const d = decoded;
    if (!d) { replaceChildren(decodedArea); return; }
    const algLine = d.algInfo
      ? `${d.alg}: ${d.algInfo.description}.`
      : unsupportedAlgReason(d.alg);
    const payload: Child = d.payloadKind === 'binary'
      ? h('p', { class: 'muted', id: 'jwt-payload-binary' }, `Binary data, ${formatByteSize(d.payloadBytes.length)}. First bytes in hex: ${hexEncode(d.payloadBytes.subarray(0, 32))}${d.payloadBytes.length > 32 ? '...' : ''}`)
      : codeBlock(d.payloadText ?? '', 'Payload', 'jwt-payload');
    replaceChildren(decodedArea,
      d.notes.length > 0 ? notice('info', noteList(d.notes, 'jwt-notes')) : null,
      section('Header', 'jwt-header-section',
        codeBlock(d.headerJson, 'Header', 'jwt-header'),
        h('p', { class: d.algInfo ? 'reach-note' : 'field-note field-note-warning', id: 'jwt-alg' }, d.algInfo ? null : icon('warning'), h('span', null, h('strong', null, 'Signature algorithm: '), algLine)),
        h('div', { class: 'toolbar' }, copyButton(services, () => d.headerJson, 'header JSON', { label: 'Copy header' })),
      ),
      section(d.payloadKind === 'claims' ? 'Payload (claims)' : 'Payload', 'jwt-payload-section', payload,
        d.payloadText !== null ? h('div', { class: 'toolbar' }, copyButton(services, () => d.payloadText, 'payload', { label: 'Copy payload' })) : null),
      section('Signature', 'jwt-signature-section',
        h('p', { class: 'reach-note', id: 'jwt-signature' }, d.signature.length === 0
          ? 'The signature part is empty.'
          : `${formatByteSize(d.signature.length)}. Base64URL: `, d.signature.length === 0 ? null : h('span', { class: 'mono break-all' }, base64Encode(d.signature, { alphabet: 'url' }))),
      ),
    );
  }

  function renderClaims(): void {
    const d = decoded;
    if (!d || !d.claims) {
      replaceChildren(claimArea);
      renderStates(null);
      return;
    }
    const rows = describeClaims(d.claims);
    const checks = currentChecks();
    const table = h('div', { class: 'table-scroll', role: 'region', tabindex: '0', 'aria-label': 'Claims table', id: 'jwt-claim-table' },
      h('table', { class: 'data-table claims-table' },
        h('caption', { class: 'visually-hidden' }, 'Claims'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Claim'), h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'Meaning'))),
        h('tbody', null, rows.map(r => h('tr', { 'data-claim': r.name },
          h('th', { scope: 'row', class: 'mono' }, r.name),
          h('td', { class: 'mono claim-value' }, r.value, r.time ? h('span', { class: 'value-note' }, r.time) : null),
          h('td', null, r.meaning ?? h('span', { class: 'muted' }, 'Not a registered claim; its meaning is up to the issuer.'),
            r.problem ? h('p', { class: 'field-note field-note-warning' }, icon('warning'), h('span', null, r.problem)) : null),
        ))),
      ),
    );
    replaceChildren(claimArea,
      rows.length === 0 ? h('p', { class: 'muted' }, 'The payload is an empty object: it makes no claims.') : table,
      section('Validity right now', 'jwt-validity',
        checks
          ? h('ul', { class: 'check-results', id: 'jwt-checks' }, checks.map(c => h('li', { 'data-check': c.id, 'data-outcome': c.outcome },
              h('span', { class: `badge badge-${CHECK_ICON[c.outcome].kind}` }, icon(CHECK_ICON[c.outcome].kind === 'ok' ? 'ok' : CHECK_ICON[c.outcome].kind), CHECK_ICON[c.outcome].word),
              h('span', null, c.message))))
          : null,
        h('p', { class: 'source-note', id: 'jwt-checked-at' }, `Checked against this device's clock at ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}. A claim check reads what the token says; without a verified signature, the token could say anything.`),
      ),
    );
    renderStates(checks);
  }

  function renderVerification(): void {
    const v = verification;
    if (!decoded) { replaceChildren(verifyResult); return; }
    if (!v) {
      replaceChildren(verifyResult, decoded.alg === 'none' ? notice('warning', h('p', { id: 'jwt-verify-message' }, unsupportedAlgReason('none'))) : null);
      return;
    }
    const warnings = v.status === 'rejected' || v.warnings.length === 0 ? null : notice('warning', h('ul', { class: 'warning-list', id: 'jwt-verify-warnings' }, v.warnings.map(w => h('li', null, w))));
    if (v.status === 'verified') {
      replaceChildren(verifyResult, notice('ok', h('p', { id: 'jwt-verify-message' }, h('strong', null, 'Signature verified. '), `The ${v.alg} signature matches the header and payload for the ${v.keySource} you supplied.`)), warnings);
    } else if (v.status === 'failed') {
      replaceChildren(verifyResult, notice('error', h('p', { id: 'jwt-verify-message' }, h('strong', null, 'Verification failed. '), v.message)), warnings);
    } else {
      replaceChildren(verifyResult, notice('warning', h('p', { id: 'jwt-verify-message', 'data-code': v.code }, h('strong', null, 'Not verified. '), v.message)));
    }
  }

  function resetVerification(): void {
    verifyRun++;
    verification = null;
    verifyButton.disabled = !decoded;
    renderVerification();
    renderStates(decoded?.claims ? currentChecks() : null);
  }

  async function verify(): Promise<void> {
    if (!decoded) return;
    const run = ++verifyRun;
    const subject = decoded;
    let outcome: VerifyOutcome;
    try {
      outcome = await verifyJwt(globalThis.crypto?.subtle, subject, keyInput());
    } catch (error) {
      outcome = { status: 'rejected', code: 'key-import', message: `The browser could not complete the check: ${(error as Error).message}` };
    }
    // The token or key changed while the check ran: this result is for something else.
    if (run !== verifyRun || subject !== decoded) return;
    verification = outcome;
    renderVerification();
    renderStates(decoded.claims ? currentChecks() : null);
    services.announce(outcome.status === 'verified' ? 'Signature verified' : outcome.status === 'failed' ? 'Signature verification failed' : 'Signature not verified');
  }

  function decode(): void {
    const text = token.value;
    tokenField.setError(null);
    verifyRun++;
    verification = null;
    decoded = null;
    gotoButton.hidden = true;
    tokenField.root.removeAttribute('data-code');
    if (text.trim() !== '') {
      const result = decodeJwt(text);
      if (result.ok) decoded = result.value;
      else {
        tokenField.setError(result.error.message);
        tokenField.root.setAttribute('data-code', result.error.code);
        const offset = result.error.offset;
        // Offsets count from the start of the token itself, after any leading whitespace.
        if (offset !== undefined && !/^\s*Bearer\s/i.test(text)) {
          const lead = text.length - text.trimStart().length;
          gotoButton.hidden = false;
          gotoButton.onclick = () => goToOffset(token, lead + offset);
        }
      }
    }
    emptyNote.hidden = decoded !== null;
    verifyButton.disabled = !decoded;
    renderDecoded();
    renderClaims();
    renderVerification();
    if (!decoded) renderStates(null);
  }

  async function example(): Promise<void> {
    const subtle = globalThis.crypto?.subtle;
    const now = Math.floor(Date.now() / 1000);
    const enc = (value: unknown) => base64Encode(new TextEncoder().encode(JSON.stringify(value)), { alphabet: 'url' });
    const signingInput = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iss: 'netforge-example', sub: 'user-1234', aud: 'example-api', iat: now, nbf: now, exp: now + 3600, scope: 'read:reports' })}`;
    let signature = '';
    if (subtle) {
      const key = await subtle.importKey('raw', new TextEncoder().encode(EXAMPLE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      signature = base64Encode(new Uint8Array(await subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))), { alphabet: 'url' });
    }
    token.value = `${signingInput}.${signature}`;
    keyKindControl.set('secret');
    keyKind = 'secret';
    secretRow.hidden = false;
    publicRow.hidden = true;
    secretFormatControl.set('text');
    secretFormat = 'text';
    secretField.control.value = EXAMPLE_SECRET;
    decode();
    token.focus();
  }

  token.addEventListener('input', decode);
  for (const control of [secretField.control, publicField.control]) control.addEventListener('input', resetVerification);
  for (const control of [issuer.control, audience.control]) control.addEventListener('input', renderClaims);

  const clear = button({
    label: 'Clear', variant: 'ghost', onClick: () => {
      token.value = '';
      secretField.control.value = '';
      publicField.control.value = '';
      issuer.control.value = '';
      audience.control.value = '';
      decode();
      token.focus();
    },
  });
  const sample = button({ label: 'Example', variant: 'ghost', onClick: () => { void example(); } });

  host.appendChild(toolPage(meta, categoryName,
    panel('Token', [tokenField.root, h('div', { class: 'toolbar' }, gotoButton)], [sample, clear]),
    states,
    stateNote,
    panel('Decoded', [decodedArea, emptyNote], undefined, 'result-panel'),
    panel('Claims', [claimArea, h('div', { class: 'controls-row' }, leeway.root, issuer.root, audience.root)]),
    panel('Verify signature (optional)', [
      h('p', { class: 'muted' }, 'Supply the key yourself. The algorithm comes from the token, and the key must be the kind that algorithm uses: a token cannot switch a public key into a shared secret.'),
      keyKindControl.root, secretRow, publicRow,
      h('div', { class: 'toolbar' }, verifyButton),
      verifyResult,
    ]),
  ));
  verifyButton.disabled = true;
  decode();
  // Time moves on while the view is hidden: refresh the validity checks on return.
  return { activate: () => { if (decoded) renderClaims(); } };
}
