/** Application infrastructure: registry, catalog, search, routing, preferences and export helpers. */
import { describe, expect, it } from 'vitest';
import { createCatalog } from '../../src/app/catalog';
import { Prefs, PREF_PREFIX, type PrefKey, type StorageLike } from '../../src/app/prefs';
import { ToolRegistry, type ToolMeta } from '../../src/app/registry';
import { formatRoute, parseRoute } from '../../src/app/router';
import { normalizeQuery, searchTools, type SearchableTool } from '../../src/app/search';
import { csvCell, toCsv } from '../../src/core/export/csv';
import { safeFilename, toJsonText } from '../../src/core/export/files';
import { formatByteSize, formatInteger, utf8Length } from '../../src/core/format';
import { describeCharAt, LineIndex } from '../../src/core/text';

/** The navigation in the Phase 0 brief, in order, plus the VLSM Allocator added in Phase 1. */
const BRIEF_NAVIGATION: [string, string[]][] = [
  ['Network', ['Subnet Calculator', 'VLSM Allocator', 'NetForge Subnet & VLAN Planner', 'IP Range Analyzer', 'Route Summarization']],
  ['Scheduling', ['Cron Explainer', 'Schedule Builder', 'Timestamp Converter']],
  ['Data', ['JSON Formatter', 'YAML/XML Tools', 'Number Bases & Bytes']],
  ['Encoding', ['Base64 / URL / Hex', 'Hash / HMAC', 'JWT Decoder']],
  ['Text', ['Regex Tester', 'List / Text Tools']],
  ['Generators', ['UUID / Random Tokens', 'chmod Calculator']],
  ['Automation / DevOps', ['PowerShell Generator', 'Terraform Export']],
];

describe('ToolRegistry', () => {
  const base = { name: 'X', summary: 'Does x.', keywords: [], category: 'c', status: 'planned' } as const;
  const fresh = () => new ToolRegistry().addCategory({ id: 'c', name: 'C' });

  it('accepts a valid tool and finds it by id', () => {
    const r = fresh().add({ ...base, id: 'x-tool' });
    expect(r.get('x-tool')?.name).toBe('X');
    expect(r.inCategory('c')).toHaveLength(1);
    expect(r.categoryName('c')).toBe('C');
  });

  it.each([
    [{ ...base, id: 'Bad_Id' }, /Invalid tool id/],
    [{ ...base, id: 'a--b' }, /Invalid tool id/],
    [{ ...base, id: '-a' }, /Invalid tool id/],
    [{ ...base, id: 'x'.repeat(65) }, /Invalid tool id/],
    [{ ...base, id: 'about' }, /reserved/],
    [{ ...base, id: 'ok', category: 'nope' }, /unknown category/],
    [{ ...base, id: 'ok', name: ' ' }, /needs a name/],
    [{ ...base, id: 'ok', summary: '' }, /needs a name/],
    [{ ...base, id: 'ok', status: 'available' }, /needs a loader/],
  ])('rejects %j', (tool, message) => {
    expect(() => fresh().add(tool as ToolMeta)).toThrow(message);
  });

  it('rejects duplicate tool and category ids', () => {
    const r = fresh().add({ ...base, id: 'dup' });
    expect(() => r.add({ ...base, id: 'dup' })).toThrow(/Duplicate tool id/);
    expect(() => r.addCategory({ id: 'c', name: 'Again' })).toThrow(/Duplicate category/);
  });
});

describe('catalog', () => {
  const catalog = createCatalog();

  it('matches the navigation in the brief (plus the Phase 1 VLSM Allocator), category by category and in order', () => {
    const actual = catalog.listCategories().map(c => [c.name, catalog.inCategory(c.id).map(t => t.name)]);
    expect(actual).toEqual(BRIEF_NAVIGATION);
  });

  it('has exactly the Phase 0, 1 and 2 tools built and every other tool planned', () => {
    expect(catalog.list().filter(t => t.status === 'available').map(t => t.id).sort()).toEqual([
      'ip-range-analyzer', 'json-formatter', 'network-planner', 'route-summarization', 'subnet-calculator', 'timestamp-converter', 'vlsm-allocator',
    ]);
    expect(catalog.list().filter(t => t.status === 'planned')).toHaveLength(13);
  });

  it('loads a module with a mount function for every built tool', async () => {
    for (const tool of catalog.list()) {
      if (tool.status !== 'available') continue;
      const module = await tool.load();
      expect(typeof module.mount).toBe('function');
    }
  });
});

describe('search', () => {
  const catalog = createCatalog();
  const entries: SearchableTool[] = catalog.list().map(tool => ({ tool, categoryName: catalog.categoryName(tool.category) }));
  const ids = (q: string) => searchTools(entries, q).map(t => t.id);

  it('lists everything, in catalog order, for an empty query', () => {
    expect(ids('')).toEqual(catalog.list().map(t => t.id));
    expect(ids('   ')).toEqual(catalog.list().map(t => t.id));
  });

  it.each([
    ['cidr', 'subnet-calculator'],
    ['netmask', 'subnet-calculator'],
    ['subnet', 'subnet-calculator'],
    ['JSON', 'json-formatter'],
    ['minify', 'json-formatter'],
    ['epoch', 'timestamp-converter'],
    ['time', 'timestamp-converter'],
    ['vlan', 'network-planner'],
    ['jwt', 'jwt-decoder'],
    ['crontab', 'cron-explainer'],
    ['sha256', 'hash-hmac'],
    ['json format', 'json-formatter'],
  ])('ranks %j first as %s', (query, first) => {
    expect(ids(query)[0]).toBe(first);
  });

  it('requires every word to match', () => {
    expect(ids('json cidr')).toEqual([]);
    expect(ids('zzzz')).toEqual([]);
  });

  it('finds tools by category name', () => {
    expect(ids('encoding').sort()).toEqual(['base64-url-hex', 'hash-hmac', 'jwt-decoder']);
  });

  it('splits queries on spaces and tabs and lowercases them', () => {
    expect(normalizeQuery(`  Subnet${String.fromCharCode(9)} CALC `)).toEqual(['subnet', 'calc']);
  });
});

describe('router', () => {
  it.each([
    ['', { name: 'home' }],
    ['#', { name: 'home' }],
    ['#/', { name: 'home' }],
    ['#/home', { name: 'home' }],
    ['#/about', { name: 'about' }],
    ['#/about/', { name: 'about' }],
    ['#/subnet-calculator', { name: 'tool', id: 'subnet-calculator' }],
    ['#/Subnet-Calculator', { name: 'tool', id: 'subnet-calculator' }],
    ['#/json-formatter/', { name: 'tool', id: 'json-formatter' }],
    ['#/json-formatter?x=1', { name: 'tool', id: 'json-formatter' }],
    ['#/a%20b', { name: 'tool', id: 'a b' }],
    ['#/%E0%A4%A', { name: 'tool', id: '%e0%a4%a' }],
  ])('parses %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it('formats routes that parse back to themselves', () => {
    for (const route of [{ name: 'home' }, { name: 'about' }, { name: 'tool', id: 'subnet-calculator' }] as const) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });
});

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  failReads = false;
  failWrites = false;
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { if (this.failReads) throw new Error('denied'); return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.failWrites) throw new Error('quota'); this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

describe('preferences', () => {
  it('returns defaults when nothing is stored', () => {
    const prefs = new Prefs(new MemoryStorage());
    expect(prefs.get('theme')).toBe('dark');
    expect(prefs.get('jsonIndent')).toBe('2');
    expect(prefs.get('timeZone')).toBe('');
    expect(prefs.stored()).toEqual([]);
  });

  it('stores valid values under the netforge. prefix', () => {
    const storage = new MemoryStorage();
    const prefs = new Prefs(storage);
    expect(prefs.set('theme', 'light')).toBe(true);
    expect(prefs.set('timeZone', 'Asia/Tokyo')).toBe(true);
    expect(storage.map.get(`${PREF_PREFIX}theme`)).toBe('light');
    expect(prefs.get('theme')).toBe('light');
    expect(prefs.stored().map(s => s.key)).toEqual(['theme', 'timeZone']);
  });

  it('refuses invalid values and stores nothing', () => {
    const storage = new MemoryStorage();
    const prefs = new Prefs(storage);
    expect(prefs.set('theme', 'blue')).toBe(false);
    expect(prefs.set('timeZone', 'Mars/Olympus_Mons')).toBe(false);
    expect(prefs.set('lastTool', 'Not An Id')).toBe(false);
    expect(prefs.set('jsonIndent', '3')).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  it('refuses keys outside the schema, so tool input cannot be stored through it', () => {
    const prefs = new Prefs(new MemoryStorage());
    expect(() => prefs.set('jwt' as PrefKey, 'eyJ...')).toThrow(/Unknown preference/);
    expect(() => prefs.get('subnetInput' as PrefKey)).toThrow(/Unknown preference/);
    expect(() => prefs.set('constructor' as PrefKey, 'x')).toThrow(/Unknown preference/);
  });

  it('ignores corrupted stored values', () => {
    const storage = new MemoryStorage();
    storage.map.set(`${PREF_PREFIX}theme`, 'neon');
    expect(new Prefs(storage).get('theme')).toBe('dark');
  });

  it('falls back to defaults when storage throws or is missing', () => {
    const storage = new MemoryStorage();
    storage.failReads = true;
    storage.failWrites = true;
    const prefs = new Prefs(storage);
    expect(prefs.get('theme')).toBe('dark');
    expect(prefs.set('theme', 'light')).toBe(false);
    expect(prefs.stored()).toEqual([]);
    const none = new Prefs(null);
    expect(none.get('theme')).toBe('dark');
    expect(none.set('theme', 'light')).toBe(false);
  });

  it('clears only NetForge keys and resets single keys', () => {
    const storage = new MemoryStorage();
    storage.map.set('other-app', 'keep');
    storage.map.set(`${PREF_PREFIX}legacyKey`, 'old');
    const prefs = new Prefs(storage);
    prefs.set('theme', 'light');
    prefs.set('jsonIndent', '4');
    prefs.reset('jsonIndent');
    expect(prefs.get('jsonIndent')).toBe('2');
    expect(storage.map.has(`${PREF_PREFIX}theme`)).toBe(true);
    prefs.clear();
    expect([...storage.map.keys()]).toEqual(['other-app']);
  });
});

describe('CSV', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['=1,2', `"'=1,2"`],
  ])('writes %j as %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('leaves numbers, bigints and booleans unguarded and writes null as empty', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(4294967296n)).toBe('4294967296');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('can turn the formula guard off', () => {
    expect(csvCell('=A1', { guardFormulas: false })).toBe('=A1');
  });

  it('refuses non-finite numbers', () => {
    expect(() => csvCell(Number.NaN)).toThrow(RangeError);
    expect(() => csvCell(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('joins rows with CRLF and ends with CRLF', () => {
    const CRLF = String.fromCharCode(13, 10);
    expect(toCsv([['Field', 'Value'], ['Mask', '255.255.255.0']])).toBe(`Field,Value${CRLF}Mask,255.255.255.0${CRLF}`);
  });
});

describe('file names', () => {
  it.each([
    ['report.json', 'report.json'],
    ['subnet-10.0.0.0-8.csv', 'subnet-10.0.0.0-8.csv'],
    [`a/b${String.fromCharCode(92)}c:d*?.txt`, 'a-b-c-d--.txt'],
    ['CON.txt', '_CON.txt'],
    ['lpt1', '_lpt1'],
    [`tab${String.fromCharCode(9)}name.txt`, 'tab-name.txt'],
    ['name. ', 'name'],
    ['', 'netforge-output.txt'],
    ['...', 'netforge-output.txt'],
    ['///', 'netforge-output.txt'],
  ])('makes %j safe as %j', (name, expected) => {
    expect(safeFilename(name)).toBe(expected);
  });

  it('shortens long names but keeps the extension', () => {
    const name = safeFilename(`${'x'.repeat(300)}.json`);
    expect(name).toHaveLength(120);
    expect(name.endsWith('.json')).toBe(true);
  });

  it('writes bigints in JSON exports as strings', () => {
    expect(toJsonText({ a: 1n, b: [2] })).toBe('{\n  "a": "1",\n  "b": [\n    2\n  ]\n}\n');
  });
});

describe('number formatting', () => {
  it('groups digits without rounding large values', () => {
    expect(formatInteger(4294967296n, 'en-US')).toBe('4,294,967,296');
    expect(formatInteger(2n ** 64n, 'en-US')).toBe('18,446,744,073,709,551,616');
    expect(formatInteger(0, 'en-US')).toBe('0');
    expect(() => formatInteger(2 ** 53, 'en-US')).toThrow(RangeError);
  });

  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [1023, '1,023 bytes'],
    [1024, '1,024 bytes (1 KiB)'],
    [1536, '1,536 bytes (1.5 KiB)'],
    [5 * 1024 * 1024, '5,242,880 bytes (5 MiB)'],
  ])('sizes %i as %j', (bytes, text) => {
    expect(formatByteSize(bytes, 'en-US')).toBe(text);
  });

  it('counts UTF-8 bytes the way Node encodes them', () => {
    const samples = ['', 'a', String.fromCharCode(0xe9), String.fromCharCode(0x20ac), String.fromCodePoint(0x1f600), String.fromCharCode(0xd800), `x${String.fromCharCode(0xdc00)}y`, 'mixed ' + String.fromCodePoint(0x1f600, 0x4e2d, 0xe9)];
    for (const s of samples) expect(utf8Length(s)).toBe(Buffer.byteLength(s, 'utf8'));
  });
});

describe('text positions', () => {
  it('locates offsets as 1-based lines and columns', () => {
    const index = new LineIndex('ab\ncd\r\nef\rgh');
    expect(index.locate(0)).toEqual({ line: 1, column: 1 });
    expect(index.locate(4)).toEqual({ line: 2, column: 2 });
    expect(index.locate(7)).toEqual({ line: 3, column: 1 });
    expect(index.locate(10)).toEqual({ line: 4, column: 1 });
  });

  it('describes printable, invisible and control characters', () => {
    expect(describeCharAt('x', 0)).toBe("'x'");
    expect(describeCharAt(String.fromCharCode(0xa0), 0)).toBe('U+00A0 (no-break space)');
    expect(describeCharAt(String.fromCharCode(0x85), 0)).toBe('U+0085 (control character)');
    expect(describeCharAt(String.fromCodePoint(0x1f600), 0)).toBe(`'${String.fromCodePoint(0x1f600)}'`);
    expect(describeCharAt('', 0)).toBe('the end of the input');
  });
});
