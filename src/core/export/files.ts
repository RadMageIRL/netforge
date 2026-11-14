/** File naming and text export helpers. Pure functions: the browser download itself lives in ui/. */

// Characters that Windows, macOS or Linux reject in file names: < > : " / \ | ? *
const FORBIDDEN = new Set([0x3c, 0x3e, 0x3a, 0x22, 0x2f, 0x5c, 0x7c, 0x3f, 0x2a]);
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME = 120;

/**
 * Makes a download file name safe on every desktop system: forbidden and control characters become
 * '-', trailing dots and spaces are removed, Windows device names are prefixed, and very long names
 * are shortened while keeping the extension.
 */
export function safeFilename(name: string, fallback = 'netforge-output.txt'): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f || FORBIDDEN.has(code) ? '-' : ch;
  }
  out = out.trim().replace(/[. ]+$/, '');
  if (out === '' || /^[.-]+$/.test(out)) return fallback;
  const dot = out.lastIndexOf('.');
  const stem = dot > 0 ? out.slice(0, dot) : out;
  const ext = dot > 0 ? out.slice(dot) : '';
  let result = RESERVED_WINDOWS.test(stem) ? `_${stem}${ext}` : out;
  if (result.length > MAX_NAME) {
    const keep = ext.length < 16 ? ext : '';
    result = result.slice(0, MAX_NAME - keep.length) + keep;
  }
  return result;
}

/** JSON text for export: bigint values become decimal strings, two-space indent, final newline. */
export function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`;
}
