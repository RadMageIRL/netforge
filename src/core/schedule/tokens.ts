/**
 * Splitting helpers that keep offsets into the original text, so errors can point at the exact
 * characters. They only split; every dialect applies its own rules to the pieces.
 */

export interface Piece {
  readonly text: string;
  /** 0-based UTF-16 offset in the original input. */
  readonly offset: number;
}

/** Whitespace-separated words (spaces and tabs), with their offsets. */
export function words(text: string): Piece[] {
  const out: Piece[] = [];
  const re = /[^ \t]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ text: m[0], offset: m.index });
  return out;
}

/** Splits `piece` on `separator`, keeping empty parts (so ",," can be reported). */
export function splitPiece(piece: Piece, separator: string): Piece[] {
  const out: Piece[] = [];
  let start = 0;
  for (;;) {
    const at = piece.text.indexOf(separator, start);
    if (at < 0) {
      out.push({ text: piece.text.slice(start), offset: piece.offset + start });
      return out;
    }
    out.push({ text: piece.text.slice(start, at), offset: piece.offset + start });
    start = at + separator.length;
  }
}

/** A short, safe rendering of user text for messages. */
export function quote(text: string): string {
  const shown = text.length > 40 ? `${text.slice(0, 37)}...` : text;
  return `"${shown}"`;
}

/** True for text made of ASCII digits only. */
export function isDigits(text: string): boolean {
  return /^[0-9]+$/.test(text);
}
