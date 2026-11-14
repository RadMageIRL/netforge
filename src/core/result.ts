/**
 * Shared result type for every parser and validator. Errors carry a stable machine-readable code
 * (tests assert codes, never wording) and a message written for the person using the tool.
 */
export interface ValidationError<C extends string = string> {
  readonly code: C;
  readonly message: string;
  /** 0-based UTF-16 offset into the input, when the error points at a position. */
  readonly offset?: number;
}

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Fail<C extends string = string> = { readonly ok: false; readonly error: ValidationError<C> };
export type Result<T, C extends string = string> = Ok<T> | Fail<C>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function fail<C extends string>(code: C, message: string, offset?: number): Fail<C> {
  return { ok: false, error: offset === undefined ? { code, message } : { code, message, offset } };
}
