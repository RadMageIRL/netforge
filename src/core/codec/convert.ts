/**
 * The encoding tool's model: read the input as one representation of some bytes, then write those
 * bytes in another. Every conversion goes through the bytes, so "Base64 to hex" and "text to URL
 * encoding" are the same operation with different ends.
 */
import { fail, ok, type Result } from '../result';
import {
  base64Decode, base64Encode, countReplacements, hexDecode, hexEncode, percentDecode, percentEncode,
  utf8Decode, utf8Encode, type CodecErrorCode,
} from './codec';

export type Representation = 'text' | 'base64' | 'base64url' | 'hex' | 'url';

export const REPRESENTATIONS: readonly { id: Representation; label: string }[] = [
  { id: 'text', label: 'Text (UTF-8)' },
  { id: 'base64', label: 'Base64' },
  { id: 'base64url', label: 'Base64URL' },
  { id: 'hex', label: 'Hex' },
  { id: 'url', label: 'URL component' },
];

export interface ConvertOptions {
  /** Base64 and hex input: ignore whitespace and separators, accept missing padding. */
  readonly lenient?: boolean;
  /** Replace invalid UTF-8 (and unpaired surrogates) with U+FFFD instead of refusing. */
  readonly replaceInvalid?: boolean;
  /** URL decoding: read "+" as a space. URL encoding: write a space as "+". */
  readonly plusAsSpace?: boolean;
  readonly upperHex?: boolean;
  /** Base64 output: true or false forces padding; undefined uses the alphabet's usual form. */
  readonly pad?: boolean;
}

export type ConvertErrorCode = CodecErrorCode | 'too-large';

/** Characters accepted in one conversion. Larger input is refused, never cut. */
export const MAX_INPUT_CHARS = 8_000_000;

export interface Conversion {
  readonly bytes: Uint8Array;
  readonly output: string;
  /** U+FFFD characters inserted by the replace option (0 when nothing was replaced). */
  readonly replaced: number;
}

export function toBytes(input: string, from: Representation, options: ConvertOptions = {}): Result<Uint8Array, ConvertErrorCode> {
  if (input.length > MAX_INPUT_CHARS) {
    return fail('too-large', `The input has ${input.length.toLocaleString('en-US')} characters; the limit is ${MAX_INPUT_CHARS.toLocaleString('en-US')}. Nothing was converted.`);
  }
  switch (from) {
    case 'text': return utf8Encode(input, { replace: options.replaceInvalid });
    case 'base64': return base64Decode(input, { alphabet: 'standard', lenient: options.lenient });
    case 'base64url': return base64Decode(input, { alphabet: 'url', lenient: options.lenient });
    case 'hex': return hexDecode(input, { lenient: options.lenient });
    case 'url': return percentDecode(input, { plusAsSpace: options.plusAsSpace });
  }
}

export function fromBytes(bytes: Uint8Array, to: Representation, options: ConvertOptions = {}): Result<string, ConvertErrorCode> {
  switch (to) {
    case 'text': return utf8Decode(bytes, { replace: options.replaceInvalid });
    case 'base64': return ok(base64Encode(bytes, { alphabet: 'standard', pad: options.pad }));
    case 'base64url': return ok(base64Encode(bytes, { alphabet: 'url', pad: options.pad }));
    case 'hex': return ok(hexEncode(bytes, options.upperHex));
    case 'url': return ok(percentEncode(bytes, { spaceAsPlus: options.plusAsSpace }));
  }
}

export type ConvertResult =
  | { readonly ok: true; readonly value: Conversion }
  | { readonly ok: false; readonly stage: 'input' | 'output'; readonly error: { code: ConvertErrorCode; message: string; offset?: number }; readonly bytes: Uint8Array | null };

/**
 * Converts `input` from one representation to another. A failure says which side it is on: the
 * input could not be read, or the bytes were read (and are returned) but cannot be written as the
 * requested output (bytes that are not UTF-8 cannot become text).
 */
export function convert(input: string, from: Representation, to: Representation, options: ConvertOptions = {}): ConvertResult {
  const bytes = toBytes(input, from, options);
  if (!bytes.ok) return { ok: false, stage: 'input', error: bytes.error, bytes: null };
  const output = fromBytes(bytes.value, to, options);
  if (!output.ok) return { ok: false, stage: 'output', error: output.error, bytes: bytes.value };
  let replaced = 0;
  if (options.replaceInvalid) {
    if (to === 'text') replaced = countReplacements(bytes.value);
    else if (from === 'text') replaced = countLoneSurrogates(input);
  }
  return { ok: true, value: { bytes: bytes.value, output: output.value, replaced } };
}

function countLoneSurrogates(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else count++;
    } else if (code >= 0xdc00 && code <= 0xdfff) count++;
  }
  return count;
}
