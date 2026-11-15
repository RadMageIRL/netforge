/**
 * Security regression tests from the Phase 6 review. Each block pins one guarantee the review
 * verified by reading the code, so a later change that breaks it fails here. Tests marked
 * FINDING describe a defect found by the review; see local/docs/SECURITY_REVIEW.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCatalog } from '../../src/app/catalog';
import { PREF_SCHEMA, Prefs, type StorageLike } from '../../src/app/prefs';
import { formatRoute, parseRoute } from '../../src/app/router';
import { jsonToYaml, yamlToJson } from '../../src/core/data/yaml';
import { xmlToJson } from '../../src/core/data/xml-tools';
import { csvCell } from '../../src/core/export/csv';
import { safeFilename } from '../../src/core/export/files';
import { neutralJson } from '../../src/core/infra/neutral';
import { terraformVariables } from '../../src/core/infra/terraform';
import { decodeJwt } from '../../src/core/jwt/jwt';
import { parsePublicKey } from '../../src/core/jwt/keys';
import { examplePlan } from '../../src/core/plan/example';
import { parsePlanJson, planToJson } from '../../src/core/plan/file';
import { powershellCommands, schtasksCommand } from '../../src/core/schedule/commands';
import type { WindowsTrigger } from '../../src/core/schedule/windows';

const ROOT = join(import.meta.dirname, '..', '..');
const PROTO = ['__proto', '__'].join('');
const WHOLE = { siteId: '', vrfId: '', namespaceId: '' };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join('/');
/** Source text without comments, so a rule named in a comment does not count as a use of it. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => line.replace(/^\s*\/\/.*$/, '')).join('\n');
}
const SRC = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'public'))];
const using = (pattern: RegExp) => SRC.filter(f => pattern.test(code(f))).map(rel).sort();

describe('static rules over src/ and public/', () => {
  it('has source files to check', () => {
    expect(SRC.length).toBeGreaterThan(80);
    expect(using(/createElement/)).toContain('src/ui/dom.ts');
  });

  it('never builds markup or code from strings', () => {
    const sinks = ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'document\\.wri' + 'te', 'srcdoc', 'DOMPar' + 'ser', 'createContextualFragment', 'setHTML' + 'Unsafe', '\\bev' + 'al\\s*\\(', 'new\\s+Func' + 'tion', 'javascr' + 'ipt:', 'setTimeout\\s*\\(\\s*[\'"`]', 'setInterval\\s*\\(\\s*[\'"`]'];
    expect(using(new RegExp(sinks.join('|')))).toEqual([]);
  });

  it('sets no URL, style or event attribute from a variable outside the two download links', () => {
    expect(using(/setAttribute\(\s*['"](href|src|action|formaction|style|on[a-z]+|srcset|data)['"]/)).toEqual([]);
    expect(using(/\.(href|src|action)\s*=[^=]/)).toEqual(['src/ui/download.ts']);
    expect(using(/window\.open|location\.(assign|replace)\(|location\.href\s*=/)).toEqual([]);
  });

  it('creates object URLs and download links in one module only', () => {
    expect(using(/createObjectURL/)).toEqual(['src/ui/download.ts']);
    expect(using(/\.download\s*=/)).toEqual(['src/ui/download.ts']);
    const text = code(join(ROOT, 'src/ui/download.ts'));
    expect(text.match(/safeFilename\(/g)!.length).toBe(2);
    expect(text.match(/revokeObjectURL/g)!.length).toBe(2);
  });

  it('opens no network connection from the page; only the service worker fetches', () => {
    const ws = '[ ]*';
    const apis = [`fet${'ch'}${ws}[(]`, `new${ws}XMLHttp${'Request'}`, `new${ws}WebSo${'cket'}`, `new${ws}EventSo${'urce'}`, `sendBea${'con'}${ws}[(]`, `new${ws}RTCPeer${'Connection'}`, `new${ws}WebTrans${'port'}`, `importScr${'ipts'}${ws}[(]`, 'navigator[.]connection'];
    expect(using(new RegExp(apis.join('|')))).toEqual(['src/sw-template.js']);
    // Dynamic imports name relative modules only.
    const remote = SRC.filter(f => /import\(\s*['"`](?!\.\.?\/)/.test(code(f))).map(rel);
    expect(remote).toEqual([]);
  });

  it('touches browser storage in the preferences module and the theme boot script only', () => {
    expect(using(/localStorage/)).toEqual(['public/theme-boot.js', 'src/app/prefs.ts']);
    expect(using(/sessionStorage|indexedDB|document\.cookie|cookieStore|\bcaches\b/)).toEqual(['src/sw-template.js']);
    expect(code(join(ROOT, 'public/theme-boot.js'))).not.toMatch(/setItem/);
  });

  it('logs nothing: no console calls that could echo a secret', () => {
    expect(using(/\bconsole\.[a-z]+\s*\(/)).toEqual([]);
  });

  it('reads the clipboard nowhere', () => {
    expect(using(/clipboard\.read|readText\s*\(|execCommand\(\s*['"]paste/)).toEqual([]);
  });

  it('starts workers only from files of the app', () => {
    const lines = SRC.flatMap(f => code(f).split('\n').filter(l => /new\s+(Shared)?Worker\s*\(/.test(l)));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(line).toMatch(/new Worker\(new URL\('\.\/[a-z.]+\.worker\.ts', import\.meta\.url\), \{ type: 'module' \}\)/);
  });
});

describe('service worker', () => {
  const sw = code(join(ROOT, 'src/sw-template.js'));

  it('stores only its precache list: nothing fetched later is written to a cache', () => {
    expect(sw).not.toMatch(/\.put\s*\(/);
    expect(sw.match(/\.addAll\s*\(/g)).toHaveLength(1);
    expect(sw).not.toMatch(/\.add\s*\(/);
    expect(sw).toMatch(/cache\.addAll\(PRECACHE\)/);
  });

  it('answers GET requests to its own origin only, and deletes only NetForge caches', () => {
    expect(sw).toMatch(/if \(request\.method !== 'GET'\) return;/);
    expect(sw).toMatch(/if \(url\.origin !== self\.location\.origin\) return;/);
    expect(sw).toMatch(/keys\.filter\(k => k\.startsWith\('netforge-'\)\)/);
  });

  it('acts on one message type and never evaluates message data', () => {
    expect(sw.match(/addEventListener\('message'/g)).toHaveLength(1);
    expect(sw).toMatch(/event\.data\.type === 'SKIP_WAITING'/);
  });
});

describe('Content-Security-Policy', () => {
  const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
  const block = /export const CSP = \[([\s\S]*?)\]\.join\('; '\)/.exec(config)![1]!;
  const directives = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
  const value = (name: string) => directives.find(d => d.startsWith(`${name} `))?.slice(name.length + 1);

  it('denies by default and allows only files of the app', () => {
    expect(value('default-src')).toBe("'none'");
    expect(value('script-src')).toBe("'self'");
    expect(value('style-src')).toBe("'self'");
    expect(value('connect-src')).toBe("'none'");
    expect(value('worker-src')).toBe("'self'");
    expect(value('base-uri')).toBe("'none'");
    expect(value('form-action')).toBe("'none'");
    expect(value('object-src')).toBe("'none'");
    expect(value('frame-src')).toBe("'none'");
  });

  it('has no unsafe keyword, wildcard, scheme source or remote host', () => {
    const all = directives.join('; ');
    expect(all).not.toMatch(/unsafe-|\*|data:|blob:|https?:|wasm-|strict-dynamic|filesystem:/);
    for (const d of directives) expect(d).toMatch(/^[a-z-]+ '(none|self)'$/);
  });

  it('is refused by the build when the page has an inline script', () => {
    expect(config).toMatch(/if \(\/<script>\/\.test\(html\)\) throw new Error/);
    expect(readFileSync(join(ROOT, 'index.html'), 'utf8')).not.toMatch(/<script>|\son[a-z]+=|style="/);
  });
});

describe('prototype pollution probes', () => {
  const clean = () => {
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).alg).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
  };

  it('YAML to JSON keeps a proto-named key as data', () => {
    const r = yamlToJson(`${PROTO}:\n  polluted: yes\nconstructor:\n  prototype:\n    polluted: yes\na: 1\n`);
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.ok ? r.output : '{}') as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([PROTO, 'constructor', 'a']);
    clean();
  });

  it('JSON to YAML keeps a proto-named key as data', () => {
    const r = jsonToYaml(`{"${PROTO}": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "a": 1}`);
    expect(r.ok).toBe(true);
    expect(r.ok ? r.output : '').toContain(`${PROTO}:\n  polluted: true\n`);
    clean();
  });

  it('XML to JSON writes element and attribute names as values, never as object structure', () => {
    const r = xmlToJson(`<${PROTO} constructor="1" polluted="1"><toString/><${PROTO} polluted="x">x</${PROTO}></${PROTO}>`);
    expect(r.ok).toBe(true);
    const doc = JSON.parse(r.ok ? r.output : '{}') as { root: { name: string; attributes: Record<string, string> } };
    expect(doc.root.name).toBe(PROTO);
    expect(Object.keys(doc.root.attributes)).toEqual(['constructor', 'polluted']);
    clean();
  });

  it('a JWT cannot change its algorithm or flags through a proto-named member', () => {
    const b64 = (v: string) => Buffer.from(v).toString('base64url');
    const r = decodeJwt(`${b64(`{"alg":"HS256","${PROTO}":{"alg":"none","b64":false,"crit":["x"]}}`)}.${b64(`{"${PROTO}":{"exp":1},"sub":"a"}`)}.${'A'.repeat(43)}`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.header.alg).toBe('HS256');
      expect((r.value.header as Record<string, unknown>).b64).toBeUndefined();
      expect(Object.hasOwn(r.value.header, 'crit')).toBe(false);
    }
    clean();
  });

  it('algorithm names that are properties of every object are not algorithms', () => {
    const b64 = (v: string) => Buffer.from(v).toString('base64url');
    for (const alg of ['constructor', 'toString', PROTO, 'hasOwnProperty', 'valueOf', 'none', 'None', 'NONE', 'nOnE', 'hs256', 'HS256 ', '']) {
      const r = decodeJwt(`${b64(JSON.stringify({ alg }))}.${b64('{"sub":"a"}')}.${'A'.repeat(43)}`);
      if (r.ok) expect(r.value.algInfo, alg).toBeNull();
      else expect(typeof r.error.code).toBe('string');
    }
    clean();
  });

  it('a JWK cannot borrow its key type from a proto-named member', () => {
    const r = parsePublicKey(`{"${PROTO}":{"kty":"RSA","n":"AQAB","e":"AQAB"},"use":"sig"}`);
    expect(r.ok).toBe(false);
    clean();
  });

  it('a plan file with proto-named fields loads as a plan or is refused, and pollutes nothing', () => {
    const text = planToJson(examplePlan()).replace('"plan": {', `"plan": { "${PROTO}": {"polluted": true}, "constructor": {"prototype": {"polluted": true}},`);
    const r = parsePlanJson(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.warnings.join(' ')).toContain('was left out');
    clean();
  });
});

describe('routes and preferences', () => {
  it('hostile hashes parse without throwing and never match a tool', () => {
    const registry = createCatalog();
    const hostile = ['#/%', '#/%E0%A4%A', `#/${PROTO}`, '#/constructor', '#/toString', '#/<img src=x onerror=alert(1)>', '#/javascript:alert(1)', '#/../../etc/passwd', `#/${'a'.repeat(100_000)}`, '#/%00', '#/about/../x', '#//', '#/?x=1', '#/subnet-calculator%2F..'];
    for (const hash of hostile) {
      const route = parseRoute(hash);
      if (route.name === 'tool') {
        expect(registry.get(route.id), hash.slice(0, 40)).toBeUndefined();
        expect(formatRoute(route)).toMatch(/^#\/[A-Za-z0-9%._~!*'()-]*$/);
      }
    }
  });

  it('stores only the four listed preferences, each validated', () => {
    expect(Object.keys(PREF_SCHEMA).sort()).toEqual(['jsonIndent', 'lastTool', 'theme', 'timeZone']);
    const written: string[] = [];
    const storage: StorageLike = { length: 0, key: () => null, getItem: () => null, setItem: (k, v) => { written.push(`${k}=${v}`); }, removeItem: () => undefined };
    const prefs = new Prefs(storage);
    for (const key of [PROTO, 'constructor', 'toString', 'token', 'plan']) expect(() => prefs.set(key as never, 'x')).toThrow();
    expect(prefs.set('lastTool', '<img src=x>')).toBe(false);
    expect(prefs.set('lastTool', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc')).toBe(false);
    expect(prefs.set('lastTool', 'a'.repeat(65))).toBe(false);
    expect(prefs.set('theme', 'dark; background:url(x)')).toBe(false);
    expect(prefs.set('timeZone', 'Not/AZone')).toBe(false);
    expect(prefs.set('jsonIndent', '8')).toBe(false);
    expect(written).toEqual([]);
    expect(prefs.set('theme', 'light')).toBe(true);
    expect(written).toEqual(['netforge.theme=light']);
  });
});

describe('download names and CSV cells', () => {
  it('removes path separators, control characters and plain device names', () => {
    const sep2 = String.fromCharCode(0x5c);
    expect(safeFilename(`..${sep2}..${sep2}x`)).toBe('..-..-x');
    expect(safeFilename('a/b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i');
    expect(safeFilename(`a${String.fromCharCode(0)}b${String.fromCharCode(10)}c`)).toBe('a-b-c');
    expect(safeFilename('CON')).toBe('_CON');
    expect(safeFilename('nul.txt')).toBe('_nul.txt');
    expect(safeFilename('...')).toBe('netforge-output.txt');
    expect(safeFilename('x'.repeat(500) + '.json').length).toBeLessThanOrEqual(120);
  });

  // FINDING S-04 (Low). Fixed in Phase 6.
  it('S-04: treats a device name with several extensions, or a padded one, as reserved', () => {
    expect(safeFilename('con.netforge-plan.json')).not.toMatch(/^con\./i);
    expect(safeFilename('COM1.tar.gz')).not.toMatch(/^com1\./i);
    expect(safeFilename('LPT1 .txt')).not.toMatch(/^lpt1 /i);
  });

  // FINDING S-04 (Low). Fixed in Phase 6.
  it('S-04: removes direction overrides and C1 controls, which can disguise an extension', () => {
    const rlo = String.fromCharCode(0x202e);
    expect(safeFilename(`a${rlo}gnp.exe`)).not.toContain(rlo);
    expect(safeFilename(`x${String.fromCharCode(0x85)}y.txt`)).toBe('x-y.txt');
  });

  it('guards every formula-starting character and leaves numbers alone', () => {
    for (const start of ['=', '+', '-', '@', String.fromCharCode(9), String.fromCharCode(13)]) expect(csvCell(`${start}cmd|' /C calc'!A0`).replace(/^"/, '')[0]).toBe("'");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('=1+1,"x"')).toBe('"\'=1+1,""x"""');
  });
});

describe('generated commands', () => {
  const trigger = { kind: 'daily', daysInterval: 1, start: { year: 2026, month: 1, day: 1, hour: 1, minute: 0, second: 0 }, repetition: null } as unknown as WindowsTrigger;

  it('never writes the stop-parsing token as a bare quoted argument (Phase 6 fix)', () => {
    for (const details of [{ name: '--%', program: 'a.exe', arguments: '' }, { name: 't', program: '--%', arguments: 'x | Stop-Computer #' }, { name: 't', program: 'a.exe', arguments: '--%' }]) {
      const out = powershellCommands(trigger, details);
      const quotes = `'"${String.fromCharCode(0x2018, 0x2019, 0x201a, 0x201b)}`;
      expect(out.text).not.toMatch(new RegExp(` [${quotes}]--%[${quotes}]( |$)`, 'm'));
      expect(out.text).toContain("('--%')");
    }
  });

  // FINDING S-03 (Low). Fixed in Phase 6.
  it('S-03: a program path that ends in a backslash cannot close the quoting of /TR', () => {
    const bs = String.fromCharCode(0x5c);
    const out = schtasksCommand(trigger, { name: 't', program: `C:${bs}my dir${bs}`, arguments: '/x /RU SYSTEM' }, 'MDY');
    // Backslash, backslash, quote reads as one backslash and a closing quote: the rest of /TR,
    // here "/RU SYSTEM", would become options of schtasks itself.
    expect(out.text).not.toContain(`${bs}${bs}" `);
  });
});

describe('plan ids that are property names of every object', () => {
  function planWithId(id: string) {
    const plan = examplePlan();
    plan.vlans[0]!.id = id;
    return parsePlanJson(planToJson(plan));
  }

  it('ordinary property names are safe as ids: nothing is lost', () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const loaded = planWithId(id);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) continue;
      const out = neutralJson(loaded.value.plan, WHOLE);
      expect(out.ok).toBe(true);
      expect(Object.keys((JSON.parse(out.files[0]!.text) as { vlans: object }).vlans)).toHaveLength(10);
    }
  });

  // FINDING S-02 (Medium). Fixed in Phase 6: the id is refused on load.
  it('S-02: a VLAN whose id is the proto name is refused on load or exported, never dropped in silence', () => {
    const loaded = planWithId(PROTO);
    // Refused on load since Phase 6; the checks below hold if that ever changes.
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) return;
    const json = neutralJson(loaded.value.plan, WHOLE);
    expect(Object.keys((JSON.parse(json.files[0]!.text) as { vlans: object }).vlans)).toHaveLength(10);
    const tf = terraformVariables(loaded.value.plan, WHOLE, 'json');
    expect(Object.keys((JSON.parse(tf.files[1]!.text) as { netforge_vlans: object }).netforge_vlans)).toHaveLength(10);
  });
});
