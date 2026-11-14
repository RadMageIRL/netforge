/**
 * A strict, non-validating XML 1.0 parser with namespace checking, written for safety first:
 *
 * - No entity is ever expanded except the five predefined ones (&lt; &gt; &amp; &apos; &quot;)
 *   and numeric character references. Entities declared in a DOCTYPE are not defined here, so
 *   entity expansion attacks ("billion laughs") have nothing to expand.
 * - Nothing is ever loaded: external DTDs, external entities and parameter entities are read as
 *   text and left alone. There is no code path that could open a file or a URL.
 *
 * The parser is iterative (no recursion), keeps comments, processing instructions, CDATA sections
 * and the exact source text of attribute values and character data, and reports the first error
 * with its line and column.
 */
import { LineIndex } from '../text';
import { XML_LIMITS } from './limits';

export { XML_LIMITS };

export interface XmlAttribute {
  /** The name as written, prefix included. */
  readonly name: string;
  /** The value with character and predefined entity references resolved. */
  readonly value: string;
  /** The value exactly as written, between its quotes. */
  readonly raw: string;
  readonly quote: '"' | "'";
}

export interface XmlElement {
  readonly type: 'element';
  readonly name: string;
  /** The namespace the element is in, or null. */
  readonly namespace: string | null;
  readonly attributes: readonly XmlAttribute[];
  readonly children: XmlNode[];
  /** True when written as <name/>. */
  readonly selfClosing: boolean;
}

export type XmlNode =
  | XmlElement
  /** Character data: `value` has references resolved, `raw` is the source text. */
  | { readonly type: 'text'; readonly value: string; readonly raw: string }
  | { readonly type: 'cdata'; readonly value: string }
  | { readonly type: 'comment'; readonly value: string }
  | { readonly type: 'pi'; readonly target: string; readonly data: string };

export interface XmlDocument {
  /** The XML declaration exactly as written, or null. */
  readonly declaration: string | null;
  readonly version: string | null;
  readonly encoding: string | null;
  readonly standalone: string | null;
  /** The DOCTYPE declaration exactly as written, or null. It is kept, never processed. */
  readonly doctype: string | null;
  /** How many of the `before` nodes come ahead of the DOCTYPE. */
  readonly doctypeAt: number;
  /** Comments and processing instructions before and after the root element. */
  readonly before: XmlNode[];
  readonly root: XmlElement;
  readonly after: XmlNode[];
  readonly notes: readonly string[];
  readonly counts: { readonly elements: number; readonly attributes: number; readonly comments: number; readonly maxDepth: number };
}

export type XmlErrorCode =
  | 'too-large' | 'empty' | 'declaration' | 'version' | 'doctype' | 'entity' | 'character' | 'name' | 'tag' | 'attribute'
  | 'duplicate-attribute' | 'mismatch' | 'unclosed' | 'comment' | 'cdata' | 'pi' | 'root' | 'text-outside-root' | 'namespace' | 'depth';

export type XmlParseResult =
  | { readonly ok: true; readonly document: XmlDocument }
  | { readonly ok: false; readonly code: XmlErrorCode; readonly message: string; readonly offset: number; readonly line: number; readonly column: number };

class XmlError extends Error {
  constructor(readonly code: XmlErrorCode, message: string, readonly offset: number) { super(message); }
}

function isNameStart(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x3a || c === 0x5f
    || (c >= 0xc0 && c <= 0xd6) || (c >= 0xd8 && c <= 0xf6) || (c >= 0xf8 && c <= 0x2ff) || (c >= 0x370 && c <= 0x37d)
    || (c >= 0x37f && c <= 0x1fff) || c === 0x200c || c === 0x200d || (c >= 0x2070 && c <= 0x218f) || (c >= 0x2c00 && c <= 0x2fef)
    || (c >= 0x3001 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xfdcf) || (c >= 0xfdf0 && c <= 0xfffd) || (c >= 0x10000 && c <= 0xeffff);
}

function isNameChar(c: number): boolean {
  return isNameStart(c) || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39) || c === 0xb7 || (c >= 0x300 && c <= 0x36f) || c === 0x203f || c === 0x2040;
}

/** The XML 1.0 Char production: tab, LF, CR and everything from space up, minus surrogates, FFFE and FFFF. */
function isXmlChar(c: number): boolean {
  return c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
}

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };
// Namespace names fixed by the XML specifications. They are identifiers, never fetched.
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const ENTITY_REFUSAL = 'NetForge never expands entities declared in a DOCTYPE: that is how entity expansion and external entity (XXE) attacks work. Only &lt; &gt; &amp; &apos; &quot; and numeric references such as &#169; are recognized.';

function label(c: number): string {
  return `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
}

class Parser {
  private i = 0;
  private readonly n: number;
  private readonly notes: string[] = [];
  private elements = 0;
  private attributeCount = 0;
  private comments = 0;
  private maxDepth = 0;
  private declaredEntities = false;

  constructor(private readonly s: string) { this.n = s.length; }

  private fail(code: XmlErrorCode, message: string, offset = this.i): never {
    throw new XmlError(code, message, offset);
  }

  private codeAt(at: number): number {
    return this.s.codePointAt(at) ?? -1;
  }

  private skipSpace(): boolean {
    const start = this.i;
    while (this.i < this.n && isSpace(this.s.charCodeAt(this.i))) this.i++;
    return this.i > start;
  }

  private readName(what: string): string {
    const start = this.i;
    let c = this.codeAt(this.i);
    if (c < 0) this.fail('name', `Expected ${what}, but the document ends here.`);
    if (!isNameStart(c)) this.fail('name', `Expected ${what}, but found ${c === 0x20 || c === 0x0a ? 'a space' : `"${String.fromCodePoint(c)}"`}. A name starts with a letter, "_" or ":".`);
    while (this.i < this.n) {
      c = this.codeAt(this.i);
      if (!isNameChar(c)) break;
      this.i += c > 0xffff ? 2 : 1;
    }
    return this.s.slice(start, this.i);
  }

  /** Checks that every character in [from, to) is allowed in XML. */
  private checkChars(from: number, to: number): void {
    for (let k = from; k < to; k++) {
      const c = this.s.charCodeAt(k);
      if (c >= 0x20 && c < 0xd800) continue;
      if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
      const cp = this.codeAt(k);
      if (!isXmlChar(cp)) this.fail('character', `The character ${label(cp)} is not allowed in XML${cp < 0x20 ? ' (control characters other than tab and line breaks are forbidden)' : ''}.`, k);
      if (cp > 0xffff) k++;
    }
  }

  /** Resolves character and predefined entity references in text or an attribute value. */
  private resolve(raw: string, base: number): string {
    if (!raw.includes('&')) return raw;
    let out = '';
    let k = 0;
    while (k < raw.length) {
      const amp = raw.indexOf('&', k);
      if (amp < 0) { out += raw.slice(k); break; }
      out += raw.slice(k, amp);
      const semi = raw.indexOf(';', amp);
      const body = semi < 0 ? '' : raw.slice(amp + 1, semi);
      if (semi < 0 || body === '' || /[\s<&]/.test(body)) {
        this.fail('entity', 'A "&" must start a reference such as &amp; or &#38;. Write a literal ampersand as &amp;.', base + amp);
      }
      if (body[0] === '#') {
        const hex = body[1] === 'x';
        const digits = body.slice(hex ? 2 : 1);
        if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) this.fail('entity', `"&${body};" is not a valid character reference. Use &#N; with decimal digits or &#xN; with hexadecimal digits.`, base + amp);
        const cp = digits.length > 8 ? -1 : parseInt(digits, hex ? 16 : 10);
        if (!isXmlChar(cp)) this.fail('entity', `"&${body};" refers to a character that is not allowed in XML.`, base + amp);
        out += String.fromCodePoint(cp);
      } else if (Object.hasOwn(PREDEFINED, body)) {
        out += PREDEFINED[body];
      } else {
        this.fail('entity', `The entity "&${body};" is not one XML defines. ${this.declaredEntities ? 'The DOCTYPE declares entities, but ' : ''}${ENTITY_REFUSAL}`, base + amp);
      }
      k = semi + 1;
    }
    return out;
  }

  private parseDeclaration(): { text: string; version: string; encoding: string | null; standalone: string | null } {
    const start = this.i;
    const end = this.s.indexOf('?>', start);
    if (end < 0) this.fail('declaration', 'The XML declaration is not closed with "?>".', start);
    const body = this.s.slice(start + 5, end);
    const m = /^\s+version\s*=\s*(?:"([^"]*)"|'([^']*)')(?:\s+encoding\s*=\s*(?:"([^"]*)"|'([^']*)'))?(?:\s+standalone\s*=\s*(?:"([^"]*)"|'([^']*)'))?\s*$/.exec(body);
    if (!m) this.fail('declaration', 'The XML declaration is malformed. It must be <?xml version="1.0"?>, optionally followed by encoding="..." and then standalone="yes" or "no", in that order.', start);
    const version = m[1] ?? m[2];
    const encoding = m[3] ?? m[4] ?? null;
    const standalone = m[5] ?? m[6] ?? null;
    if (!/^1\.[0-9]+$/.test(version)) this.fail('version', `"${version}" is not an XML version.`, start);
    if (version !== '1.0') this.fail('version', `This document says XML ${version}. NetForge reads XML 1.0 only.`, start);
    if (encoding !== null && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) this.fail('declaration', `"${encoding}" is not a valid encoding name.`, start);
    if (standalone !== null && standalone !== 'yes' && standalone !== 'no') this.fail('declaration', 'standalone must be "yes" or "no".', start);
    this.i = end + 2;
    if (encoding !== null && !/^utf-?8$/i.test(encoding)) {
      this.notes.push(`The declaration says the encoding is ${encoding}. Pasted text is already decoded, so NetForge reads it as it appears here and keeps the declaration unchanged.`);
    }
    return { text: this.s.slice(start, this.i), version, encoding, standalone };
  }

  /**
   * Reads a DOCTYPE declaration as text, without processing it. Quoted strings, comments and the
   * internal subset are skipped over by their own rules so that a "]" or ">" inside them does not
   * end the declaration early.
   */
  private parseDoctype(): string {
    const start = this.i;
    this.i += 9;
    if (!this.skipSpace()) this.fail('doctype', 'A DOCTYPE needs a space and then the root element\'s name.');
    this.readName('the root element name in the DOCTYPE');
    let external = false;
    let subset = false;
    let closed = false;
    while (this.i < this.n && !closed) {
      const c = this.s[this.i];
      if (c === '"' || c === "'") {
        const close = this.s.indexOf(c, this.i + 1);
        if (close < 0) this.fail('doctype', 'A quoted string in the DOCTYPE is not closed.');
        this.i = close + 1;
      } else if (c === '[') {
        subset = true;
        this.i++;
        this.skipSubset();
      } else if (c === '>') {
        closed = true;
        this.i++;
      } else if (this.s.startsWith('SYSTEM', this.i) || this.s.startsWith('PUBLIC', this.i)) {
        external = true;
        this.i += 6;
      } else if (c === '<') {
        this.fail('doctype', 'The DOCTYPE is not closed with ">" before the next tag.');
      } else this.i++;
    }
    if (!closed) this.fail('doctype', 'The DOCTYPE is not closed with ">".', start);
    this.checkChars(start, this.i);
    if (external) this.notes.push('The DOCTYPE names an external DTD. NetForge does not load it, or anything else: the document is checked for well-formedness only, not validated against the DTD.');
    if (subset) {
      this.notes.push(this.declaredEntities
        ? 'The DOCTYPE declares entities. NetForge keeps the declaration as text and does not define them, so any use of those entities in the document is an error.'
        : 'The DOCTYPE has an internal subset. NetForge keeps it as text and does not process it: no defaults are applied and nothing is validated.');
    } else if (!external) this.notes.push('The DOCTYPE is kept as written. The document is checked for well-formedness only.');
    return this.s.slice(start, this.i);
  }

  private skipSubset(): void {
    while (this.i < this.n) {
      const c = this.s[this.i];
      if (c === ']') { this.i++; return; }
      if (c === '"' || c === "'") {
        const close = this.s.indexOf(c, this.i + 1);
        if (close < 0) this.fail('doctype', 'A quoted string in the DOCTYPE is not closed.');
        this.i = close + 1;
      } else if (this.s.startsWith('<!--', this.i)) {
        const close = this.s.indexOf('-->', this.i + 4);
        if (close < 0) this.fail('doctype', 'A comment in the DOCTYPE is not closed.');
        this.i = close + 3;
      } else {
        if (this.s.startsWith('<!ENTITY', this.i)) this.declaredEntities = true;
        this.i++;
      }
    }
    this.fail('doctype', 'The DOCTYPE\'s internal subset is not closed with "]".');
  }

  private parseComment(): XmlNode {
    const start = this.i;
    const end = this.s.indexOf('-->', start + 4);
    if (end < 0) this.fail('comment', 'This comment is not closed with "-->".', start);
    const value = this.s.slice(start + 4, end);
    const dashes = value.indexOf('--');
    if (dashes >= 0) this.fail('comment', 'A comment cannot contain "--".', start + 4 + dashes);
    if (value.endsWith('-')) this.fail('comment', 'A comment cannot end with "--->": the text before "-->" must not end with a hyphen.', end - 1);
    this.checkChars(start + 4, end);
    this.i = end + 3;
    this.comments++;
    return { type: 'comment', value };
  }

  private parsePi(): XmlNode {
    const start = this.i;
    this.i += 2;
    const target = this.readName('a processing instruction target');
    if (target.toLowerCase() === 'xml') this.fail('pi', 'The XML declaration (<?xml ... ?>) is only allowed at the very start of the document, before anything else, including blank lines and comments.', start);
    const end = this.s.indexOf('?>', this.i);
    if (end < 0) this.fail('pi', 'This processing instruction is not closed with "?>".', start);
    let data = '';
    if (end > this.i) {
      if (!isSpace(this.s.charCodeAt(this.i))) this.fail('pi', 'A processing instruction needs a space between its target and its content.');
      data = this.s.slice(this.i, end).replace(/^[ \t\r\n]+/, '');
    }
    this.checkChars(start, end);
    this.i = end + 2;
    return { type: 'pi', target, data };
  }

  private parseAttributes(elementName: string): XmlAttribute[] {
    const attributes: XmlAttribute[] = [];
    const names = new Set<string>();
    for (;;) {
      const hadSpace = this.skipSpace();
      const c = this.s[this.i];
      if (c === undefined) this.fail('unclosed', `The tag <${elementName}> is not closed with ">".`);
      if (c === '>' || c === '/') return attributes;
      if (!hadSpace) this.fail('tag', `Expected a space, ">" or "/>" in the tag <${elementName}>, but found "${c}".`);
      const at = this.i;
      const name = this.readName('an attribute name');
      if (names.has(name)) this.fail('duplicate-attribute', `The attribute "${name}" appears more than once in <${elementName}>.`, at);
      names.add(name);
      this.skipSpace();
      if (this.s[this.i] !== '=') this.fail('attribute', `The attribute "${name}" needs a value: write ${name}="...". XML has no attributes without values.`);
      this.i++;
      this.skipSpace();
      const quote = this.s[this.i];
      if (quote !== '"' && quote !== "'") this.fail('attribute', `The value of "${name}" must be in quotes: ${name}="...".`);
      const valueStart = this.i + 1;
      const close = this.s.indexOf(quote, valueStart);
      if (close < 0) this.fail('attribute', `The value of "${name}" is missing its closing quote.`, this.i);
      const raw = this.s.slice(valueStart, close);
      const lt = raw.indexOf('<');
      if (lt >= 0) this.fail('attribute', `The value of "${name}" contains "<", which must be written as &lt; inside an attribute.`, valueStart + lt);
      this.checkChars(valueStart, close);
      // Attribute-value normalization: a literal tab or line break counts as a space.
      const value = this.resolve(raw.replace(/\r\n|[\t\n\r]/g, ' '), valueStart);
      this.i = close + 1;
      attributes.push({ name, value, raw, quote });
      if (attributes.length > XML_LIMITS.attributes) this.fail('attribute', `The tag <${elementName}> has more than ${XML_LIMITS.attributes.toLocaleString('en-US')} attributes.`, at);
    }
  }

  parse(): XmlDocument {
    const s = this.s;
    if (s.charCodeAt(0) === 0xfeff) {
      this.i = 1;
      this.notes.push('The text starts with a byte order mark (U+FEFF), which XML allows and NetForge skips.');
    }
    let declaration: ReturnType<Parser['parseDeclaration']> | null = null;
    if (s.startsWith('<?xml', this.i) && isSpace(s.charCodeAt(this.i + 5))) declaration = this.parseDeclaration();

    let doctype: string | null = null;
    let doctypeAt = 0;
    const before: XmlNode[] = [];
    const after: XmlNode[] = [];
    let root: XmlElement | null = null;

    interface Frame { readonly element: XmlElement; readonly start: number; readonly bindings: Map<string, string> }
    const stack: Frame[] = [];
    const lookup = (prefix: string): string | undefined => {
      for (let k = stack.length - 1; k >= 0; k--) {
        const uri = stack[k].bindings.get(prefix);
        if (uri !== undefined) return uri;
      }
      return prefix === 'xml' ? XML_NS : undefined;
    };

    while (this.i < this.n) {
      const top = stack.length > 0 ? stack[stack.length - 1] : null;
      const siblings = top ? top.element.children : root ? after : before;
      if (s.charCodeAt(this.i) !== 0x3c) {
        const start = this.i;
        let end = s.indexOf('<', start);
        if (end < 0) end = this.n;
        const raw = s.slice(start, end);
        if (!top) {
          const bad = /[^ \t\r\n]/.exec(raw);
          if (bad) {
            this.fail('text-outside-root', root
              ? 'There is text after the end of the root element. A document has exactly one root element, and nothing but comments and processing instructions may follow it.'
              : 'There is text before the root element. A document must start with markup: an XML declaration, a comment, or the root element.', start + bad.index);
          }
          this.i = end;
          continue;
        }
        const cdataEnd = raw.indexOf(']]>');
        if (cdataEnd >= 0) this.fail('cdata', 'The sequence "]]>" is not allowed in text; write it as ]]&gt;.', start + cdataEnd);
        this.checkChars(start, end);
        // Line ends are normalized before references are resolved, so a carriage return written
        // as &#13; stays one.
        siblings.push({ type: 'text', value: this.resolve(raw.replace(/\r\n?/g, '\n'), start), raw });
        this.i = end;
        continue;
      }

      if (s.startsWith('<!--', this.i)) { siblings.push(this.parseComment()); continue; }
      if (s.startsWith('<?', this.i)) { siblings.push(this.parsePi()); continue; }
      if (s.startsWith('<![CDATA[', this.i)) {
        if (!top) this.fail('cdata', 'A CDATA section is only allowed inside an element.');
        const end = s.indexOf(']]>', this.i + 9);
        if (end < 0) this.fail('cdata', 'This CDATA section is not closed with "]]>".');
        this.checkChars(this.i + 9, end);
        siblings.push({ type: 'cdata', value: s.slice(this.i + 9, end).replace(/\r\n?/g, '\n') });
        this.i = end + 3;
        continue;
      }
      if (s.startsWith('<!DOCTYPE', this.i)) {
        if (root || top) this.fail('doctype', 'A DOCTYPE is only allowed before the root element.');
        if (doctype !== null) this.fail('doctype', 'A document can have only one DOCTYPE.');
        doctype = this.parseDoctype();
        doctypeAt = before.length;
        continue;
      }
      if (s.startsWith('<!', this.i)) this.fail('tag', 'This is not valid markup. After "<!" XML expects a comment (<!--), a CDATA section (<![CDATA[) or a DOCTYPE.');

      if (s.charCodeAt(this.i + 1) === 0x2f) {
        const at = this.i;
        this.i += 2;
        const name = this.readName('an element name in the closing tag');
        this.skipSpace();
        if (s[this.i] !== '>') this.fail('tag', `The closing tag </${name} is not finished with ">".`);
        this.i++;
        if (!top) this.fail('mismatch', `The closing tag </${name}> has no matching opening tag.`, at);
        if (top.element.name !== name) {
          const opened = this.index().locate(top.start);
          this.fail('mismatch', `The closing tag </${name}> does not match the open element <${top.element.name}> (opened on line ${opened.line}, column ${opened.column}). Elements must be closed in the reverse of the order they were opened.`, at);
        }
        stack.pop();
        continue;
      }

      // A start tag.
      const at = this.i;
      this.i++;
      if (root && !top) this.fail('root', 'There is a second root element. A document has exactly one element at the top level; wrap the others inside it.', at);
      const name = this.readName('an element name');
      const attributes = this.parseAttributes(name);
      let selfClosing = false;
      if (s[this.i] === '/') {
        if (s[this.i + 1] !== '>') this.fail('tag', `In <${name}>, "/" must be followed at once by ">".`);
        selfClosing = true;
        this.i += 2;
      } else this.i++;

      // Namespaces: collect this element's declarations, then check every prefix it uses.
      const bindings = new Map<string, string>();
      for (const a of attributes) {
        if (a.name === 'xmlns') bindings.set('', a.value);
        else if (a.name.startsWith('xmlns:')) {
          const prefix = a.name.slice(6);
          if (prefix === '' || prefix.includes(':')) this.fail('namespace', `"${a.name}" is not a valid namespace declaration.`, at);
          if (prefix === 'xmlns') this.fail('namespace', 'The prefix "xmlns" is reserved and cannot be declared.', at);
          if (prefix === 'xml' && a.value !== XML_NS) this.fail('namespace', 'The prefix "xml" is reserved and cannot be bound to another namespace.', at);
          if (prefix !== 'xml' && (a.value === XML_NS || a.value === XMLNS_NS)) this.fail('namespace', `The namespace bound to "${prefix}" is reserved for XML itself.`, at);
          if (a.value === '') this.fail('namespace', `The namespace declaration ${a.name}="" is empty. A prefix cannot be undeclared in XML 1.0.`, at);
          bindings.set(prefix, a.value);
        }
      }
      const element: XmlElement = { type: 'element', name, namespace: null, attributes, children: [], selfClosing };
      const frame: Frame = { element, start: at, bindings };
      stack.push(frame);
      const split = (qname: string, what: string): [string, string] => {
        const parts = qname.split(':');
        if (parts.length > 2 || parts.some(p => p === '')) this.fail('namespace', `The ${what} name "${qname}" is not a valid qualified name: a name may contain one colon, with a prefix before it and a local name after it.`, at);
        return parts.length === 2 ? [parts[0], parts[1]] : ['', parts[0]];
      };
      const [prefix] = split(name, 'element');
      const namespace = prefix === '' ? lookup('') ?? null : lookup(prefix) ?? this.fail('namespace', `The prefix "${prefix}" in <${name}> is not bound to a namespace. Declare it with xmlns:${prefix}="..." on this element or one that contains it.`, at);
      (element as { namespace: string | null }).namespace = namespace === '' ? null : namespace;
      const expanded = new Set<string>();
      for (const a of attributes) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const [p, local] = split(a.name, 'attribute');
        if (p === '') continue;
        const uri = lookup(p) ?? this.fail('namespace', `The prefix "${p}" in the attribute "${a.name}" is not bound to a namespace. Declare it with xmlns:${p}="...".`, at);
        const key = `${uri} ${local}`;
        if (expanded.has(key)) this.fail('duplicate-attribute', `<${name}> has two attributes named "${local}" in the same namespace, under different prefixes.`, at);
        expanded.add(key);
      }

      if (top) siblings.push(element);
      else root = element;
      this.elements++;
      this.attributeCount += attributes.length;
      if (stack.length > this.maxDepth) this.maxDepth = stack.length;
      if (stack.length > XML_LIMITS.depth) this.fail('depth', `Elements are nested deeper than ${XML_LIMITS.depth.toLocaleString('en-US')} levels.`, at);
      if (selfClosing) stack.pop();
    }

    if (stack.length > 0) {
      const open = stack[stack.length - 1];
      this.fail('unclosed', `The element <${open.element.name}> is never closed. Add </${open.element.name}>.`, open.start);
    }
    if (!root) this.fail('empty', declaration || doctype || before.length > 0 ? 'The document has no root element.' : 'There is no XML here: a document needs at least one element.', 0);
    return {
      declaration: declaration?.text ?? null, version: declaration?.version ?? null, encoding: declaration?.encoding ?? null, standalone: declaration?.standalone ?? null,
      doctype, doctypeAt, before, root: root as XmlElement, after, notes: this.notes,
      counts: { elements: this.elements, attributes: this.attributeCount, comments: this.comments, maxDepth: this.maxDepth },
    };
  }

  private lineIndex: LineIndex | null = null;
  index(): LineIndex {
    return (this.lineIndex ??= new LineIndex(this.s));
  }
}

export function parseXml(text: string): XmlParseResult {
  if (text.length > XML_LIMITS.inputChars) {
    return { ok: false, code: 'too-large', message: `The XML has ${text.length.toLocaleString('en-US')} characters; the limit is ${XML_LIMITS.inputChars.toLocaleString('en-US')}. Nothing was processed.`, offset: 0, line: 1, column: 1 };
  }
  const parser = new Parser(text);
  try {
    return { ok: true, document: parser.parse() };
  } catch (error) {
    if (!(error instanceof XmlError)) throw error;
    const where = parser.index().locate(error.offset);
    return { ok: false, code: error.code, message: error.message, offset: error.offset, line: where.line, column: where.column };
  }
}
