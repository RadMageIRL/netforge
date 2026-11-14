/**
 * YAML and XML against independent implementations: PyYAML for YAML values, and expat (through
 * Python) for XML well-formedness, namespace checking and document structure. The fixture is
 * written by scripts/oracles/data_oracle.py, which also lists what is deliberately left out.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseXml, type XmlNode } from '../../src/core/data/xml';
import { formatXml, xmlToJson } from '../../src/core/data/xml-tools';
import { formatYaml, validateYaml, yamlToJson } from '../../src/core/data/yaml';

interface YamlCase { name: string; yaml: string; json: string | null; documents: number; exact?: boolean }
type Tree = { before: unknown[]; root: unknown; after: unknown[] };
interface XmlCase { name: string; xml: string; wellFormed: boolean; namespaceOk: boolean; tree?: Tree; design?: 'entity' | 'dtd-default' | 'version'; expatError?: string }
interface Fixture { pyyaml: string; expat: string; yaml: YamlCase[]; xml: XmlCase[] }

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'data-oracle.json'), 'utf8')) as Fixture;

/** Parses JSON keeping integers exact (as tagged strings), so values beyond 2^53 still compare. */
function exactParse(text: string): unknown {
  const reviver = function (this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
    if (typeof value === 'number' && context?.source !== undefined && /^-?[0-9]+$/.test(context.source)) return `int:${BigInt(context.source)}`;
    return value;
  };
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

describe('YAML against PyYAML', () => {
  it('has the expected corpus', () => {
    expect(fixture.pyyaml).toBe('6.0.3');
    expect(fixture.yaml.length).toBeGreaterThan(300);
    expect(fixture.yaml.filter(c => c.json === null).length).toBeGreaterThanOrEqual(10);
    expect(fixture.yaml.filter(c => c.documents > 1).length).toBeGreaterThanOrEqual(4);
    // The reviver really sees number sources on this runtime, or big integers would compare loosely.
    expect(exactParse('[9007199254740993, 1.5]')).toEqual(['int:9007199254740993', 1.5]);
  });

  it('rejects every document PyYAML rejects', () => {
    const invalid = fixture.yaml.filter(c => c.json === null);
    const accepted = invalid.filter(c => validateYaml(c.yaml).ok || yamlToJson(c.yaml).ok || formatYaml(c.yaml).ok).map(c => c.name);
    expect(accepted).toEqual([]);
  });

  it('reads the same value PyYAML reads from every valid document', () => {
    const wrong: string[] = [];
    let compared = 0;
    for (const c of fixture.yaml) {
      if (c.json === null) continue;
      const r = yamlToJson(c.yaml, '');
      if (!r.ok) { wrong.push(`${c.name}: refused (${r.errors[0].message})`); continue; }
      const mine = r.output.slice(0, -1);
      // PyYAML reports an empty document as null; a single null document converts as null too.
      const expected = c.json;
      try {
        expect(exactParse(mine)).toEqual(exactParse(expected));
        if (c.exact) expect(mine).toBe(expected);
      } catch {
        wrong.push(`${c.name}: got ${mine.slice(0, 200)} expected ${expected.slice(0, 200)}`);
      }
      compared++;
    }
    expect(wrong).toEqual([]);
    expect(compared).toBe(fixture.yaml.filter(c => c.json !== null).length);
  });

  it('formatting never changes the value', () => {
    const wrong: string[] = [];
    for (const c of fixture.yaml) {
      if (c.json === null) continue;
      for (const indent of [2, 4] as const) {
        const formatted = formatYaml(c.yaml, indent);
        if (!formatted.ok) { wrong.push(`${c.name}: format refused`); continue; }
        const again = yamlToJson(formatted.output, '');
        const direct = yamlToJson(c.yaml, '');
        if (!again.ok || !direct.ok || again.output !== direct.output) wrong.push(`${c.name} (indent ${indent})`);
        const twice = formatYaml(formatted.output, indent);
        if (!twice.ok || twice.output !== formatted.output) wrong.push(`${c.name} (indent ${indent}): not idempotent`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

function tree(text: string): Tree | null {
  const r = parseXml(text);
  if (!r.ok) return null;
  const node = (n: XmlNode): unknown => {
    if (n.type === 'text') return ['t', n.value];
    if (n.type === 'cdata') return ['cd', n.value];
    if (n.type === 'comment') return ['c', n.value];
    if (n.type === 'pi') return ['pi', n.target, n.data];
    return ['e', n.name, n.attributes.map(a => [a.name, a.value]), n.children.map(node)];
  };
  // Keys in the fixture's (sorted) order, so the two can be compared as text.
  return { after: r.document.after.map(node), before: r.document.before.map(node), root: node(r.document.root) };
}

describe('XML against expat', () => {
  const plain = fixture.xml.filter(c => !c.design);

  it('has the expected corpus', () => {
    expect(fixture.expat).toMatch(/^expat_2[.]/);
    expect(fixture.xml.length).toBeGreaterThan(700);
    expect(fixture.xml.filter(c => c.wellFormed && c.namespaceOk).length).toBeGreaterThan(300);
    expect(fixture.xml.filter(c => !c.wellFormed).length).toBeGreaterThan(300);
    expect(fixture.xml.filter(c => c.wellFormed && !c.namespaceOk).length).toBeGreaterThan(10);
    expect(fixture.xml.filter(c => c.design === 'entity').length).toBeGreaterThanOrEqual(3);
  });

  it('accepts exactly the documents expat accepts with namespace checking', () => {
    const wrong: string[] = [];
    for (const c of plain) {
      const r = parseXml(c.xml);
      const expected = c.wellFormed && c.namespaceOk;
      if (r.ok !== expected) wrong.push(`${c.name}: NetForge ${r.ok ? 'accepts' : `rejects (${r.code}: ${r.message})`}, expat ${expected ? 'accepts' : `rejects (${c.expatError ?? 'namespace'})`}: ${JSON.stringify(c.xml).slice(0, 300)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('rejects namespace errors as namespace errors', () => {
    const wrong: string[] = [];
    for (const c of plain) {
      if (!c.wellFormed || c.namespaceOk) continue;
      const r = parseXml(c.xml);
      if (r.ok || (r.code !== 'namespace' && r.code !== 'duplicate-attribute')) wrong.push(`${c.name}: ${r.ok ? 'accepted' : r.code}`);
    }
    expect(wrong).toEqual([]);
  });

  it('builds the same tree expat reports for every accepted document', () => {
    const wrong: string[] = [];
    let compared = 0;
    for (const c of plain) {
      if (!c.wellFormed || !c.namespaceOk) continue;
      const mine = tree(c.xml);
      if (JSON.stringify(mine) !== JSON.stringify(c.tree)) wrong.push(`${c.name}: ${JSON.stringify(c.xml).slice(0, 200)}\n  mine  ${JSON.stringify(mine).slice(0, 400)}\n  expat ${JSON.stringify(c.tree).slice(0, 400)}`);
      compared++;
    }
    expect(wrong).toEqual([]);
    expect(compared).toBeGreaterThan(300);
  });

  it('formatting keeps the tree expat reports, apart from layout whitespace', () => {
    const strip = (t: Tree | null) => JSON.stringify(t, (_k, v: unknown) => (Array.isArray(v) && v[0] === 'e'
      ? [v[0], v[1], v[2], (v[3] as unknown[]).filter(c => !(Array.isArray(c) && c[0] === 't' && /^[ \t\r\n]*$/.test(c[1] as string)))]
      : v));
    const wrong: string[] = [];
    for (const c of plain) {
      if (!c.wellFormed || !c.namespaceOk) continue;
      for (const indent of ['  ', null]) {
        const formatted = formatXml(c.xml, indent);
        if (!formatted.ok || strip(tree(formatted.output)) !== strip(c.tree as Tree)) wrong.push(`${c.name} (${indent === null ? 'minify' : 'pretty'})`);
      }
      if (!xmlToJson(c.xml).ok) wrong.push(`${c.name}: xmlToJson refused`);
    }
    expect(wrong).toEqual([]);
  });

  it('differs from expat only where it is designed to', () => {
    for (const c of fixture.xml.filter(x => x.design)) {
      const r = parseXml(c.xml);
      if (c.design === 'entity') {
        // expat expands entities declared in the DOCTYPE; NetForge refuses to.
        expect(c.wellFormed, c.name).toBe(true);
        expect(JSON.stringify(c.tree), c.name).toMatch(/expanded|oneone/);
        expect(!r.ok && r.code, c.name).toBe('entity');
      } else if (c.design === 'version') {
        // expat does not check the version number; NetForge reads XML 1.0 only.
        expect(c.wellFormed, c.name).toBe(true);
        expect(!r.ok && r.code, c.name).toBe('version');
      } else {
        expect(c.design, c.name).toBe('dtd-default');
        // expat adds the attribute default from the DOCTYPE; NetForge does not process the DOCTYPE.
        expect(JSON.stringify(c.tree?.root), c.name).toContain('dflt');
        expect(r.ok && r.document.root.attributes, c.name).toEqual([]);
      }
    }
  });
});
