/**
 * YAML validation, formatting and conversion to and from JSON.
 *
 * Parsing is done by the bundled "yaml" package (YAML 1.2, core schema), the one dependency
 * NetForge ships: a correct YAML parser is too large to write safely by hand. Everything around it
 * is here: limits, exact numbers, and an account of whatever a conversion cannot carry across.
 * JSON has no comments, anchors, tags or non-string keys, so each of those is either reported or
 * refused; none is dropped without saying so.
 */
import {
  Document, isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit,
  type Node as YamlNode, type ParsedNode, type ScalarTag, type YAMLError,
} from 'yaml';
import { base64Encode } from '../codec/codec';
import { LineIndex } from '../text';
import type { DataIssue, DataResult } from './data-result';
import { analyzeJson } from './json';
import { YAML_LIMITS } from './limits';

export { YAML_LIMITS };

export type { DataIssue, DataResult } from './data-result';

export type YamlIndent = 2 | 4;

/** A number kept as the exact text it was written with, so formatting never respells it. */
class RawNumber {
  constructor(readonly text: string) {}
}

const RAW_NUMBER_TAG: ScalarTag = {
  identify: value => value instanceof RawNumber,
  default: true,
  tag: 'tag:netforge.invalid,2026:raw-number',
  // Never matches: this tag exists only to write numbers back out.
  test: /^(?!)/,
  resolve: text => text,
  stringify: item => (item.value as RawNumber).text,
};

const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/;

const failure = (message: string, line = 1, column = 1): DataResult => ({ ok: false, errors: [{ line, column, message }], omitted: 0 });

function tooLarge(text: string, what: string): DataResult | null {
  return text.length > YAML_LIMITS.inputChars
    ? failure(`The ${what} has ${text.length.toLocaleString('en-US')} characters; the limit is ${YAML_LIMITS.inputChars.toLocaleString('en-US')}. Nothing was processed.`)
    : null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

type Parsed = { ok: false; result: DataResult } | { ok: true; docs: Document.Parsed[]; warnings: DataIssue[]; index: LineIndex };

function parseYaml(text: string): Parsed {
  const index = new LineIndex(text);
  const issue = (e: YAMLError): DataIssue => ({ ...index.locate(e.pos[0]), message: e.message });
  let docs: Document.Parsed[];
  try {
    docs = parseAllDocuments(text, { version: '1.2', intAsBigInt: true, prettyErrors: false, customTags: [RAW_NUMBER_TAG], uniqueKeys: true }) as Document.Parsed[];
  } catch (error) {
    const deep = error instanceof RangeError;
    return { ok: false, result: failure(deep ? 'The YAML is nested too deeply to process.' : `The YAML could not be read: ${(error as Error).message}`) };
  }
  const errors = docs.flatMap(d => d.errors.map(issue));
  // The parser accepts an alias to an anchor that was never set; it only fails later, on use.
  for (const doc of docs) {
    visit(doc, {
      Alias(_key, node) {
        if (!node.resolve(doc)) errors.push({ ...index.locate(node.range?.[0] ?? 0), message: `The alias *${node.source} refers to an anchor that is not defined before it.` });
      },
    });
  }
  if (errors.length > 0) {
    return { ok: false, result: { ok: false, errors: errors.slice(0, YAML_LIMITS.issues), omitted: Math.max(0, errors.length - YAML_LIMITS.issues) } };
  }
  return { ok: true, docs, warnings: docs.flatMap(d => d.warnings.map(issue)).slice(0, YAML_LIMITS.issues), index };
}

function countComments(doc: Document.Parsed): number {
  let count = (doc.commentBefore ? 1 : 0) + (doc.comment ? 1 : 0);
  visit(doc, { Node(_key, node) { if (node.commentBefore) count++; if (node.comment) count++; } });
  return count;
}

/** Text whose first line with any content starts with a space or tab. */
const LEADING_SPACE = /^\n*[ \t]/;
const EMPTY_DOCUMENT_TAIL = /\n$/;

const NEWLINE = String.fromCharCode(10);

/** A document with no content and no comments, such as the nothing between two "---" lines. */
function isEmptyDocument(doc: Document.Parsed): boolean {
  const c = doc.contents as unknown;
  if (doc.comment || doc.commentBefore) return false;
  return c === null || (isScalar(c) && c.value === null && c.source === '' && !c.comment && !c.commentBefore && !c.anchor && !c.tag);
}

/** True when two parsed nodes hold the same data: values, number text, tags, anchors and aliases. */
function sameData(a: unknown, b: unknown): boolean {
  if (isAlias(a) || isAlias(b)) return isAlias(a) && isAlias(b) && a.source === b.source;
  if (isScalar(a) || isScalar(b)) {
    if (!isScalar(a) || !isScalar(b) || a.tag !== b.tag || a.anchor !== b.anchor) return false;
    const x = a.value as unknown;
    const y = b.value as unknown;
    if (x instanceof RawNumber) return (typeof y === 'number' || typeof y === 'bigint') && b.source === x.text;
    if (x instanceof Uint8Array) return y instanceof Uint8Array && x.length === y.length && x.every((v, i) => v === y[i]);
    return Object.is(x, y);
  }
  if (isSeq(a) && isSeq(b)) {
    return a.tag === b.tag && a.anchor === b.anchor && a.items.length === b.items.length && a.items.every((item, i) => sameData(item, b.items[i]));
  }
  if (isMap(a) && isMap(b)) {
    return a.tag === b.tag && a.anchor === b.anchor && a.items.length === b.items.length
      && a.items.every((pair, i) => sameData(pair.key, b.items[i].key) && sameData(pair.value, b.items[i].value));
  }
  return (a === null || a === undefined) && (b === null || b === undefined);
}

/**
 * Validates YAML and writes it back with consistent indentation. Comments, anchors, aliases,
 * tags, quoting styles, key order and the spelling of numbers are kept. Spacing inside flow
 * collections and the alignment of comments are normalized; long lines are not folded.
 */
export function formatYaml(text: string, indent: YamlIndent = 2): DataResult {
  const big = tooLarge(text, 'YAML');
  if (big) return big;
  const parsed = parseYaml(text);
  if (!parsed.ok) return parsed.result;
  const { docs } = parsed;
  if (docs.length === 0) {
    return { ok: true, output: text, summary: 'No YAML document: only comments or blank lines', warnings: [], notes: ['The text is returned unchanged.'] };
  }
  const parts: string[] = [];
  let output: string;
  try {
    docs.forEach((doc, i) => {
      visit(doc, {
        Scalar(_key, node) {
          // A number without an explicit tag keeps its exact text. (With a tag, the tag decides
          // how the value is written, so the value must stay a number.)
          if ((typeof node.value === 'number' || typeof node.value === 'bigint') && typeof node.source === 'string' && !node.tag) node.value = new RawNumber(node.source);
          // A block scalar whose text starts with a space needs an indentation indicator, which
          // the library writes correctly only for nested values at two-space indentation.
          // Elsewhere such text is written in double quotes, which holds it exactly.
          else if ((node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') && typeof node.value === 'string' && LEADING_SPACE.test(node.value) && (indent !== 2 || node === doc.contents)) {
            node.type = 'QUOTE_DOUBLE';
          }
        },
      });
      if (i > 0) doc.directives.docStart = true;
      const written = doc.toString({ indent, lineWidth: 0 });
      // An empty document is written as a blank line, which would grow on every pass.
      parts.push(isEmptyDocument(doc) && written.endsWith(NEWLINE + NEWLINE) ? written.replace(EMPTY_DOCUMENT_TAIL, '') : written);
    });
    output = parts.join('');
    // Formatting must never change the data. Read the result back and compare it, node by node,
    // with what was read from the input; refuse rather than hand back something different.
    const check = parseAllDocuments(output, { version: '1.2', intAsBigInt: true, prettyErrors: false, customTags: [RAW_NUMBER_TAG], uniqueKeys: true }) as Document.Parsed[];
    const same = check.length === docs.length && check.every((doc, i) => doc.errors.length === 0 && sameData(docs[i].contents, doc.contents));
    if (!same) return failure('Formatting was stopped: the formatted text would not read back as exactly the same data, which is a limit of the YAML library with this document. The YAML itself is valid.');
  } catch (error) {
    return failure(error instanceof RangeError ? 'The YAML is nested too deeply to format.' : `The YAML could not be formatted: ${(error as Error).message}`);
  }
  if (output.length > YAML_LIMITS.outputChars) return failure(`The formatted YAML would be larger than ${YAML_LIMITS.outputChars.toLocaleString('en-US')} characters.`);
  return {
    ok: true, output, summary: `Valid YAML: ${plural(docs.length, 'document')}`, warnings: parsed.warnings,
    notes: ['Comments, anchors, tags, quoting and the spelling of numbers are kept. Indentation, spacing inside [ ] and { }, and comment alignment are normalized.'],
  };
}

/** Validates YAML without producing output. */
export function validateYaml(text: string): DataResult {
  const big = tooLarge(text, 'YAML');
  if (big) return big;
  const parsed = parseYaml(text);
  if (!parsed.ok) return parsed.result;
  const n = parsed.docs.length;
  return { ok: true, output: '', summary: n === 0 ? 'No YAML document: only comments or blank lines' : `Valid YAML: ${plural(n, 'document')}`, warnings: parsed.warnings, notes: [] };
}

class ConversionError extends Error {
  constructor(message: string, readonly offset: number) { super(message); }
}

interface JsonWriterState {
  readonly parts: string[];
  chars: number;
  aliases: number;
  nonStringKeys: number;
  binaries: number;
  mergeKeys: number;
  respelled: number;
}

function numberText(value: number | bigint, source: string | undefined, state: JsonWriterState, offset: number): string {
  // Keep the text as written when it is already a JSON number with the same value (1.50 stays
  // 1.50, and 1e400 stays exact even though it is too large for a JavaScript number).
  if (source !== undefined && JSON_NUMBER.test(source) && (typeof value === 'bigint' ? !/[.eE]/.test(source) : Number(source) === value)) return source;
  if (typeof value === 'bigint') {
    if (source !== undefined) state.respelled++;
    return value.toString();
  }
  if (!Number.isFinite(value)) {
    throw new ConversionError(`${Number.isNaN(value) ? 'Not-a-number (.nan)' : 'Infinity (.inf)'} has no JSON representation. Change the value or quote it to make it a string.`, offset);
  }
  if (source !== undefined) state.respelled++;
  return Object.is(value, -0) ? '-0' : String(value);
}

function writeJson(doc: Document.Parsed, indent: string, state: JsonWriterState): void {
  const resolving = new Set<unknown>();
  const push = (s: string) => {
    state.chars += s.length;
    if (state.chars > YAML_LIMITS.outputChars) {
      throw new ConversionError(`The JSON would be larger than ${YAML_LIMITS.outputChars.toLocaleString('en-US')} characters${state.aliases > 0 ? ', because aliases repeat the same data many times' : ''}. Nothing was converted.`, 0);
    }
    state.parts.push(s);
  };
  const at = (node: unknown) => (node as ParsedNode | null)?.range?.[0] ?? 0;
  const newline = (depth: number) => (indent === '' ? '' : `\n${indent.repeat(depth)}`);

  const keyText = (key: unknown): string => {
    let node = key;
    if (isAlias(node)) node = node.resolve(doc);
    if (isScalar(node)) {
      if (typeof node.value === 'string') return node.value;
      state.nonStringKeys++;
      if (node.value === null) return typeof node.source === 'string' && node.source !== '' ? node.source : 'null';
      if (node.value instanceof Uint8Array) throw new ConversionError('A binary value cannot be a JSON object name.', at(key));
      return typeof node.source === 'string' ? node.source : String(node.value);
    }
    throw new ConversionError('This mapping key is a list or mapping. JSON object names must be strings, so it cannot be converted.', at(key));
  };

  const write = (node: unknown, depth: number): void => {
    if (depth > YAML_LIMITS.depth) throw new ConversionError(`The data is nested deeper than ${YAML_LIMITS.depth} levels.`, at(node));
    if (node === null || node === undefined) { push('null'); return; }
    if (isAlias(node)) {
      const target = node.resolve(doc);
      if (!target) throw new ConversionError(`The alias *${node.source} refers to an anchor that does not exist.`, at(node));
      if (resolving.has(target)) throw new ConversionError(`The alias *${node.source} refers to the collection that contains it. JSON cannot express a structure that contains itself.`, at(node));
      state.aliases++;
      write(target, depth);
      return;
    }
    if (isScalar(node)) {
      const v = node.value as unknown;
      if (v === null) push('null');
      else if (typeof v === 'boolean') push(String(v));
      else if (typeof v === 'number' || typeof v === 'bigint') push(numberText(v, typeof node.source === 'string' ? node.source : undefined, state, at(node)));
      else if (typeof v === 'string') push(JSON.stringify(v));
      else if (v instanceof Uint8Array) { state.binaries++; push(JSON.stringify(base64Encode(v))); }
      else throw new ConversionError('This value has a type JSON cannot represent.', at(node));
      return;
    }
    if (isSeq(node)) {
      if (node.items.length === 0) { push('[]'); return; }
      resolving.add(node);
      push('[');
      node.items.forEach((item, i) => {
        push((i > 0 ? ',' : '') + newline(depth + 1));
        write(item, depth + 1);
      });
      push(`${newline(depth)}]`);
      resolving.delete(node);
      return;
    }
    if (isMap(node)) {
      if (node.items.length === 0) { push('{}'); return; }
      resolving.add(node);
      const seen = new Set<string>();
      push('{');
      node.items.forEach((pair, i) => {
        const key = keyText(pair.key);
        if (seen.has(key)) throw new ConversionError(`Two keys become the same JSON name ${JSON.stringify(key)} (one is a string and one is not), so the mapping cannot be converted without losing a value.`, at(pair.key));
        seen.add(key);
        if (key === '<<') state.mergeKeys++;
        push(`${i > 0 ? ',' : ''}${newline(depth + 1)}${JSON.stringify(key)}:${indent === '' ? '' : ' '}`);
        write(pair.value, depth + 1);
      });
      push(`${newline(depth)}}`);
      resolving.delete(node);
      return;
    }
    throw new ConversionError('This node has a type JSON cannot represent.', at(node));
  };
  write(doc.contents, 0);
}

/**
 * Converts YAML to JSON. One document becomes one JSON value; several become a JSON array of
 * them. What JSON cannot hold is reported in `notes` (comments, expanded aliases, keys that were
 * not strings) or refused outright (infinity, not-a-number, collection keys, recursive aliases).
 */
export function yamlToJson(text: string, indent: string = '  '): DataResult {
  const big = tooLarge(text, 'YAML');
  if (big) return big;
  const parsed = parseYaml(text);
  if (!parsed.ok) return parsed.result;
  const { docs, index } = parsed;
  if (docs.length === 0) return failure('There is no YAML document to convert: the text holds only comments or blank lines.');

  const state: JsonWriterState = { parts: [], chars: 0, aliases: 0, nonStringKeys: 0, binaries: 0, mergeKeys: 0, respelled: 0 };
  const many = docs.length > 1;
  try {
    if (many) state.parts.push('[');
    docs.forEach((doc, i) => {
      if (many) state.parts.push(`${i > 0 ? ',' : ''}${indent === '' ? '' : '\n'}`);
      const before = state.parts.length;
      writeJson(doc, indent, state);
      // Documents inside the array sit one level in.
      if (many && indent !== '') {
        const body = state.parts.splice(before).join('');
        state.parts.push(indent + body.split('\n').join(`\n${indent}`));
      }
    });
    if (many) state.parts.push(`${indent === '' ? '' : '\n'}]`);
  } catch (error) {
    if (error instanceof ConversionError) {
      const where = index.locate(error.offset);
      return failure(error.message, where.line, where.column);
    }
    return failure(error instanceof RangeError ? 'The YAML is nested too deeply to convert.' : `The YAML could not be converted: ${(error as Error).message}`);
  }

  const notes: string[] = [];
  const comments = docs.reduce((n, d) => n + countComments(d), 0);
  if (many) notes.push(`The input has ${docs.length} YAML documents. JSON holds one value, so they are written as an array of ${docs.length} items.`);
  if (comments > 0) notes.push(`${plural(comments, 'comment')} not carried over: JSON has no comments.`);
  if (state.aliases > 0) notes.push(`${plural(state.aliases, 'alias', 'aliases')} written out in full: JSON has no anchors or references, so shared data is repeated.`);
  if (state.nonStringKeys > 0) notes.push(`${plural(state.nonStringKeys, 'key')} that ${state.nonStringKeys === 1 ? 'was' : 'were'} not a string (a number, true, false or null) written as a string: JSON object names are always strings.`);
  if (state.binaries > 0) notes.push(`${plural(state.binaries, 'binary value')} (!!binary) written as Base64 text.`);
  if (state.respelled > 0) notes.push(`${plural(state.respelled, 'number')} written in a different form with the same value (hexadecimal, octal or a form JSON does not allow).`);
  if (state.mergeKeys > 0) notes.push('A "<<" key is kept as an ordinary key. Merge keys belong to YAML 1.1; this tool follows YAML 1.2, which has none.');
  if (parsed.warnings.length > 0) notes.push('Tags that are not part of the YAML 1.2 core schema were not applied; those values are converted as their plain type.');
  notes.push('YAML 1.2 rules apply: only true and false are booleans (yes, no, on, off are strings), and dates are strings.');
  return { ok: true, output: `${state.parts.join('')}\n`, summary: `Converted ${plural(docs.length, 'YAML document')} to JSON`, warnings: parsed.warnings, notes };
}

// JSON to YAML --------------------------------------------------------------------------------

/** Reads JSON that has already been validated, keeping each number's text and every object's order. */
function readJson(text: string): unknown {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skip = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const numberAt = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
  const readString = (): string => {
    const start = i;
    i++;
    while (text[i] !== '"') i += text.charCodeAt(i) === 0x5c ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const read = (): unknown => {
    skip();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const map = new Map<string, unknown>();
      skip();
      if (text[i] === '}') { i++; return map; }
      for (;;) {
        skip();
        const key = readString();
        skip();
        i++;
        map.set(key, read());
        skip();
        if (text[i++] === '}') return map;
      }
    }
    if (ch === '[') {
      i++;
      const list: unknown[] = [];
      skip();
      if (text[i] === ']') { i++; return list; }
      for (;;) {
        list.push(read());
        skip();
        if (text[i++] === ']') return list;
      }
    }
    if (ch === '"') return readString();
    if (ch === 't') { i += 4; return true; }
    if (ch === 'f') { i += 5; return false; }
    if (ch === 'n') { i += 4; return null; }
    numberAt.lastIndex = i;
    const m = numberAt.exec(text)!;
    i += m[0].length;
    return new RawNumber(m[0]);
  };
  return read();
}

/** Multi-line text with a line that begins with a space or tab. */
const FRAGILE_BLOCK = /^[ \t][^]*\n|\n[ \t]/;
/** A byte order mark written plain at the start of the output would be dropped by the next parser. */
const BOM = String.fromCharCode(0xfeff);

/** YAML 1.1 reads a number as a float only with a decimal point and a signed exponent. */
const YAML11_EXPONENT_TRAP = /^-?[0-9]+[eE]|[eE][0-9]/;

/**
 * Converts JSON to block-style YAML. Numbers keep their exact text; strings that an older
 * YAML 1.1 parser would read as something else (yes, no, on, off, 0123, 1:30) are quoted so the
 * result means the same thing everywhere.
 */
export function jsonToYaml(text: string, indent: YamlIndent = 2): DataResult {
  const big = tooLarge(text, 'JSON');
  if (big) return big;
  const analysis = analyzeJson(text);
  if (!analysis.ok) {
    const { line, column } = analysis.error.location;
    return failure(analysis.error.message, line, column);
  }
  const duplicate = analysis.warnings.find(w => w.code === 'duplicate-key');
  if (duplicate) {
    return failure(`${duplicate.message} YAML mappings must have unique keys, so this JSON cannot be converted without dropping a value.`, duplicate.location.line, duplicate.location.column);
  }
  if (analysis.stats.maxDepth > YAML_LIMITS.depth) return failure(`The JSON is nested ${analysis.stats.maxDepth} levels deep; the limit for conversion is ${YAML_LIMITS.depth}.`);

  let output: string;
  let traps = 0;
  try {
    const value = readJson(text);
    const doc = new Document(value, { version: '1.2', customTags: [RAW_NUMBER_TAG], compat: 'yaml-1.1' });
    visit(doc as unknown as YamlNode, {
      Scalar(_key, node) {
        if (node.value instanceof RawNumber && YAML11_EXPONENT_TRAP.test(node.value.text)) traps++;
        // A block scalar cannot reliably hold text with a line that starts with a space or tab
        // (the indentation becomes ambiguous), so such text is written in double quotes. So is
        // text with a byte order mark.
        else if (typeof node.value === 'string' && (FRAGILE_BLOCK.test(node.value) || node.value.includes(BOM))) node.type = 'QUOTE_DOUBLE';
      },
    });
    output = doc.toString({ indent, lineWidth: 0 });
  } catch (error) {
    return failure(`The JSON could not be converted: ${(error as Error).message}`);
  }
  if (output.length > YAML_LIMITS.outputChars) return failure(`The YAML would be larger than ${YAML_LIMITS.outputChars.toLocaleString('en-US')} characters.`);
  const notes = ['Numbers are written exactly as in the JSON. Strings that YAML 1.1 parsers would misread (such as yes, no, on, 0123) are quoted.'];
  if (traps > 0) {
    notes.push(`${plural(traps, 'number')} ${traps === 1 ? 'uses' : 'use'} an exponent without a decimal point or sign (like 1e3). That is a number in YAML 1.2, but YAML 1.1 parsers such as PyYAML read it as a string.`);
  }
  return { ok: true, output, summary: `Converted JSON (${analysis.stats.rootType}, ${plural(analysis.stats.values, 'value')}) to YAML`, warnings: [], notes };
}
