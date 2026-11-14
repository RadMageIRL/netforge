/**
 * XML formatting and conversion to JSON, on top of the parser in xml.ts.
 *
 * Formatting changes whitespace only where it cannot matter: between the children of an element
 * that contains nothing but other elements, comments and processing instructions. An element that
 * holds text is written back exactly as it was read.
 *
 * XML and JSON have different shapes (attributes, mixed text, comments, repeated and ordered
 * children, namespaces), so the conversion uses one explicit model rather than guessing:
 *
 *   element  {"name": "ns:tag", "namespace": "uri", "attributes": {"id": "1"}, "children": [...]}
 *   text     "a string"
 *   CDATA    {"cdata": "..."}
 *   comment  {"comment": "..."}
 *   PI       {"pi": "target", "data": "..."}
 *
 * Children are always an array in document order, so repeated elements and mixed content survive.
 */
import type { DataResult } from './data-result';
import { parseXml, type XmlDocument, type XmlElement, type XmlNode } from './xml';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function failed(result: Extract<ReturnType<typeof parseXml>, { ok: false }>): DataResult {
  return { ok: false, errors: [{ line: result.line, column: result.column, message: result.message }], omitted: 0 };
}

function summary(doc: XmlDocument): string {
  const c = doc.counts;
  return `Well-formed XML: root <${doc.root.name}>, ${plural(c.elements, 'element')}, ${plural(c.attributes, 'attribute')}, depth ${c.maxDepth}`;
}

const WELL_FORMED_NOTE = 'Well-formed means the syntax and namespaces are correct. NetForge does not validate against a DTD or schema.';

export function validateXml(text: string): DataResult {
  const parsed = parseXml(text);
  if (!parsed.ok) return failed(parsed);
  return { ok: true, output: '', summary: summary(parsed.document), warnings: [], notes: [...parsed.document.notes, WELL_FORMED_NOTE] };
}

const isBlank = (text: string) => /^[ \t\r\n]*$/.test(text);

/** True when whitespace between this element's children is layout, not content. */
function isStructural(element: XmlElement): boolean {
  let markup = false;
  for (const child of element.children) {
    if (child.type === 'cdata') return false;
    if (child.type === 'text') { if (!isBlank(child.raw)) return false; }
    else markup = true;
  }
  return markup;
}

function spacePreserved(element: XmlElement, inherited: boolean): boolean {
  const attr = element.attributes.find(a => a.name === 'xml:space');
  return attr ? attr.value === 'preserve' : inherited;
}

function startTag(element: XmlElement): string {
  let out = `<${element.name}`;
  for (const a of element.attributes) out += ` ${a.name}=${a.quote}${a.raw}${a.quote}`;
  return out;
}

function leaf(node: Exclude<XmlNode, XmlElement>): string {
  if (node.type === 'text') return node.raw;
  if (node.type === 'cdata') return `<![CDATA[${node.value}]]>`;
  if (node.type === 'comment') return `<!--${node.value}-->`;
  return `<?${node.target}${node.data === '' ? '' : ` ${node.data}`}?>`;
}

/** Writes an element exactly as parsed, adding no whitespace. */
function verbatim(element: XmlElement, out: string[]): void {
  out.push(startTag(element));
  if (element.selfClosing) { out.push('/>'); return; }
  out.push('>');
  for (const child of element.children) {
    if (child.type === 'element') verbatim(child, out);
    else out.push(leaf(child));
  }
  out.push(`</${element.name}>`);
}

/** `indent` null means minify: no whitespace is added and layout whitespace is removed. */
function layout(element: XmlElement, depth: number, indent: string | null, preserve: boolean, out: string[]): void {
  const keep = spacePreserved(element, preserve);
  if (keep || element.selfClosing || !isStructural(element)) { verbatim(element, out); return; }
  const inner = indent === null ? '' : `\n${indent.repeat(depth + 1)}`;
  out.push(`${startTag(element)}>`);
  for (const child of element.children) {
    if (child.type === 'text') continue;
    out.push(inner);
    if (child.type === 'element') layout(child, depth + 1, indent, keep, out);
    else out.push(leaf(child));
  }
  out.push(`${indent === null ? '' : `\n${indent.repeat(depth)}`}</${element.name}>`);
}

/**
 * Pretty-prints (indent given) or minifies (indent null) XML. Attribute values, quotes, entity
 * references, comments, CDATA sections and the DOCTYPE are written back as they were read.
 */
export function formatXml(text: string, indent: string | null): DataResult {
  const parsed = parseXml(text);
  if (!parsed.ok) return failed(parsed);
  const doc = parsed.document;
  const out: string[] = [];
  const sep = indent === null ? '' : '\n';
  if (doc.declaration !== null) out.push(doc.declaration, sep);
  const misc = (nodes: readonly XmlNode[], lead: boolean) => {
    for (const node of nodes) {
      if (node.type === 'element') continue;
      if (lead) out.push(sep);
      out.push(leaf(node));
      if (!lead) out.push(sep);
    }
  };
  misc(doc.before.slice(0, doc.doctypeAt), false);
  if (doc.doctype !== null) out.push(doc.doctype, sep);
  misc(doc.before.slice(doc.doctypeAt), false);
  layout(doc.root, 0, indent, false, out);
  misc(doc.after, true);
  if (indent !== null) out.push('\n');
  const notes = [
    ...doc.notes,
    indent === null
      ? 'Whitespace was removed only between tags inside elements that contain no text. Elements that hold text, and anything under xml:space="preserve", are unchanged.'
      : 'Whitespace was changed only between tags inside elements that contain no text. Elements that hold text, and anything under xml:space="preserve", are unchanged.',
  ];
  return { ok: true, output: out.join(''), summary: summary(doc), warnings: [], notes };
}

type Json = string | null | Json[] | Map<string, Json>;

function writeJson(value: Json, indent: string, depth: number, out: string[]): void {
  if (value === null) { out.push('null'); return; }
  if (typeof value === 'string') { out.push(JSON.stringify(value)); return; }
  const nl = (d: number) => (indent === '' ? '' : `\n${indent.repeat(d)}`);
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push('[]'); return; }
    out.push('[');
    value.forEach((item, i) => { out.push((i > 0 ? ',' : '') + nl(depth + 1)); writeJson(item, indent, depth + 1, out); });
    out.push(`${nl(depth)}]`);
    return;
  }
  if (value.size === 0) { out.push('{}'); return; }
  out.push('{');
  let i = 0;
  for (const [key, item] of value) {
    out.push(`${i++ > 0 ? ',' : ''}${nl(depth + 1)}${JSON.stringify(key)}:${indent === '' ? '' : ' '}`);
    writeJson(item, indent, depth + 1, out);
  }
  out.push(`${nl(depth)}}`);
}

export interface XmlJsonOptions {
  readonly indent?: string;
  /** Keep whitespace-only text between elements (off by default; the count left out is reported). */
  readonly keepWhitespace?: boolean;
}

/** Converts XML to JSON using the model described at the top of this file. */
export function xmlToJson(text: string, options: XmlJsonOptions = {}): DataResult {
  const parsed = parseXml(text);
  if (!parsed.ok) return failed(parsed);
  const doc = parsed.document;
  const indent = options.indent ?? '  ';
  let dropped = 0;
  let resolved = 0;

  const node = (n: XmlNode, structural: boolean): Json | undefined => {
    if (n.type === 'text') {
      if (structural && !options.keepWhitespace) { dropped++; return undefined; }
      if (n.raw.includes('&')) resolved++;
      return n.value;
    }
    if (n.type === 'cdata') return new Map<string, Json>([['cdata', n.value]]);
    if (n.type === 'comment') return new Map<string, Json>([['comment', n.value]]);
    if (n.type === 'pi') return new Map<string, Json>([['pi', n.target], ['data', n.data]]);
    const map = new Map<string, Json>([['name', n.name]]);
    if (n.namespace !== null) map.set('namespace', n.namespace);
    if (n.attributes.length > 0) {
      const attributes = new Map<string, Json>();
      for (const a of n.attributes) {
        if (a.raw.includes('&')) resolved++;
        attributes.set(a.name, a.value);
      }
      map.set('attributes', attributes);
    }
    const layoutOnly = isStructural(n);
    const children: Json[] = [];
    for (const child of n.children) {
      const value = node(child, layoutOnly);
      if (value !== undefined) children.push(value);
    }
    if (children.length > 0) map.set('children', children);
    return map;
  };
  const list = (nodes: readonly XmlNode[]) => nodes.map(n => node(n, false)).filter((v): v is Json => v !== undefined);

  const top = new Map<string, Json>();
  if (doc.declaration !== null) {
    const declaration = new Map<string, Json>([['version', doc.version]]);
    if (doc.encoding !== null) declaration.set('encoding', doc.encoding);
    if (doc.standalone !== null) declaration.set('standalone', doc.standalone);
    top.set('declaration', declaration);
  }
  if (doc.doctype !== null) top.set('doctype', doc.doctype);
  if (doc.before.length > 0) top.set('before', list(doc.before));
  top.set('root', node(doc.root, false) as Json);
  if (doc.after.length > 0) top.set('after', list(doc.after));

  const out: string[] = [];
  writeJson(top, indent, 0, out);
  out.push('\n');
  const notes = [
    ...doc.notes,
    'Conversion model: an element is an object with "name", then "namespace", "attributes" and "children" when it has them. Children stay in document order as an array: text is a string, and comments, CDATA sections and processing instructions are small objects. Nothing is merged, so repeated elements stay separate.',
  ];
  if (dropped > 0) notes.push(`${plural(dropped, 'whitespace-only text node')} between tags left out (indentation and line breaks). Turn on "Keep whitespace between tags" to include them.`);
  if (resolved > 0) notes.push(`${plural(resolved, 'value')} had entity or character references (such as &amp;), which are written as the characters they stand for.`);
  notes.push('Not carried over: which quotes attributes used, self-closing versus empty tags, and whitespace inside tags.');
  return { ok: true, output: out.join(''), summary: `${summary(doc)}; converted to JSON`, warnings: [], notes };
}
