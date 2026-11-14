/**
 * Repository rules, checked on every run over the files git would publish (tracked files plus
 * untracked files that are not ignored). Each detector is first shown to catch a planted sample,
 * so a broken detector cannot pass as a clean result.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const TEXT = /\.(ts|js|mjs|json|css|html|md|svg|py|txt|yml|yaml|gitignore|gitattributes)$|^\.git(ignore|attributes)$/;

function publishable(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(Boolean).filter(f => !f.startsWith('node_modules/'));
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

// Patterns are assembled from pieces so this file does not trip its own checks.
const EM_DASH = String.fromCharCode(0x2014);
const ATTRIBUTION = new RegExp([
  ['co', 'authored', 'by'].join('-'),
  ['clau', 'de'].join(''),
  ['anthro', 'pic'].join(''),
  ['chat', 'gpt'].join(''),
  ['open', 'ai'].join(''),
  ['copi', 'lot'].join(''),
  ['ai', 'generated'].join('[- ]'),
  ['generated', 'with', 'ai'].join(' '),
  ['generated', 'by', 'ai'].join(' '),
].join('|'), 'i');
const UNSAFE_DOM = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function\s*\()/;
const NETWORK_API = /\b(fetch\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)\b|sendBeacon\s*\(|importScripts\s*\()/;
const URL_PATTERN = /https?:\/\/[^\s'"`)<>]+/g;
const ALLOWED_URLS = new Set([
  'http://www.w3.org/2000/svg',
  // Source citations for the bundled IANA registry data, shown as text and never fetched.
  'https://www.iana.org/assignments/iana-ipv4-special-registry/',
  'https://www.iana.org/assignments/iana-ipv6-special-registry/',
  'https://www.iana.org/assignments/ipv6-address-space/',
]);

const findEmDash = (text: string) => text.includes(EM_DASH);
const findAttribution = (text: string) => ATTRIBUTION.test(text);
const findNonAscii = (text: string) => [...text].some(ch => ch.codePointAt(0)! > 0x7e || (ch.codePointAt(0)! < 0x20 && !'\t\n\r'.includes(ch)));
const findUnsafeDom = (text: string) => UNSAFE_DOM.test(text);
const findNetworkApi = (text: string) => NETWORK_API.test(text);
const findUrls = (text: string) => (text.match(URL_PATTERN) ?? []).filter(u => !ALLOWED_URLS.has(u));

describe('detectors catch planted samples', () => {
  it('em dash', () => expect(findEmDash(`a ${EM_DASH} b`)).toBe(true));
  it('attribution', () => {
    expect(findAttribution(['Co', 'Authored', 'By: someone'].join('-'))).toBe(true);
    expect(findAttribution(`written by ${['Clau', 'de'].join('')}`)).toBe(true);
    expect(findAttribution(['AI', 'generated code'].join('-'))).toBe(true);
    expect(findAttribution('plain text about subnets')).toBe(false);
  });
  it('non-ASCII', () => {
    expect(findNonAscii(`caf${String.fromCharCode(0xe9)}`)).toBe(true);
    expect(findNonAscii('plain\ttext\r\n')).toBe(false);
  });
  it('unsafe DOM', () => {
    expect(findUnsafeDom(`el.${'inner'}HTML = x`)).toBe(true);
    expect(findUnsafeDom(`${'ev'}al(code)`)).toBe(true);
    expect(findUnsafeDom('el.textContent = x')).toBe(false);
  });
  it('network API', () => {
    expect(findNetworkApi(`${'fet'}ch('/x')`)).toBe(true);
    expect(findNetworkApi(`navigator.${'send'}Beacon(u)`)).toBe(true);
    expect(findNetworkApi(`new ${'Web'}Socket(url)`)).toBe(true);
    expect(findNetworkApi(`new ${'XMLHttp'}Request()`)).toBe(true);
    expect(findNetworkApi('prefetch = false')).toBe(false);
    expect(findNetworkApi('blocks fetch, XHR, WebSocket or beacons')).toBe(false);
  });
  it('external URL', () => {
    expect(findUrls(`see ${'https'}://example.com/x`)).toEqual([`${'https'}://example.com/x`]);
    expect(findUrls(`ns ${'http'}://www.w3.org/2000/svg`)).toEqual([]);
  });
});

describe('repository rules', () => {
  const files = publishable();
  const textFiles = files.filter(f => TEXT.test(f.split('/').pop()!));

  it('sees the files it is meant to check', () => {
    expect(files).toContain('src/main.ts');
    expect(files).toContain('README.md');
    expect(textFiles.length).toBeGreaterThan(30);
  });

  it('publishes no Markdown except README.md and CHANGELOG.md', () => {
    expect(files.filter(f => f.endsWith('.md')).sort()).toEqual(['CHANGELOG.md', 'README.md']);
  });

  it('publishes nothing from local/ or other private locations', () => {
    expect(files.filter(f => f.startsWith('local/') || f.startsWith('.claude/') || f.startsWith('dist/') || /(^|\/)\.env/.test(f))).toEqual([]);
  });

  it('has no em dashes in any published text file', () => {
    expect(textFiles.filter(f => findEmDash(read(f)))).toEqual([]);
  });

  it('has no AI attribution in any published text file', () => {
    expect(textFiles.filter(f => f !== 'tests/unit/house.test.ts' && findAttribution(read(f)))).toEqual([]);
  });

  it('keeps application source ASCII-only (characters are built from code points)', () => {
    const source = textFiles.filter(f => f.startsWith('src/') || f.startsWith('public/') || f === 'index.html' || f.startsWith('tests/') && !f.startsWith('tests/fixtures/'));
    expect(source.filter(f => findNonAscii(read(f)))).toEqual([]);
  });

  it('never builds HTML from strings or evaluates code in the app', () => {
    expect(textFiles.filter(f => f.startsWith('src/') && findUnsafeDom(read(f)))).toEqual([]);
  });

  it('has no network APIs in the app (the service worker alone fetches its own files)', () => {
    expect(textFiles.filter(f => f.startsWith('src/') && f !== 'src/sw-template.js' && findNetworkApi(read(f)))).toEqual([]);
  });

  it('loads nothing from other sites: no external URLs in the app', () => {
    const app = textFiles.filter(f => f.startsWith('src/') || f.startsWith('public/') || f === 'index.html');
    expect(app.flatMap(f => findUrls(read(f)).map(u => `${f}: ${u}`))).toEqual([]);
  });

  it('ships no runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; private?: boolean };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.private).toBe(true);
  });

  it('keeps connect-src none in the production Content-Security-Policy', () => {
    const config = read('vite.config.ts');
    expect(config).toContain(`"connect-src 'none'"`);
    expect(config).toContain(`"default-src 'none'"`);
  });
});
