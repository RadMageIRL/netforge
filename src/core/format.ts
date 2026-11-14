/** Number formatting shared by every tool. Display values may be localized; copied values never are. */

const integerFormats = new Map<string, Intl.NumberFormat>();

function integerFormat(locale: string | undefined): Intl.NumberFormat {
  const key = locale ?? '';
  let format = integerFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
    integerFormats.set(key, format);
  }
  return format;
}

/** Groups digits for display (4,294,967,296 in en-US). Accepts bigint so no value is ever rounded. */
export function formatInteger(value: bigint | number, locale?: string): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError(`Not a safe integer: ${value}`);
  return integerFormat(locale).format(value);
}

const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'];

/** "3,214 bytes" or "3,214 bytes (3.1 KiB)". The exact count always comes first. */
export function formatByteSize(bytes: number, locale?: string): string {
  const exact = `${formatInteger(bytes, locale)} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024) return exact;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const approx = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  return `${exact} (${approx} ${BYTE_UNITS[unit]})`;
}

/** UTF-8 byte length of a string, without allocating the encoded bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
