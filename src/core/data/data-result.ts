/** The result shape shared by the YAML and XML operations. */

export interface DataIssue {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export type DataResult =
  | { readonly ok: false; readonly errors: readonly DataIssue[]; readonly omitted: number }
  | {
      readonly ok: true;
      readonly output: string;
      /** One line saying what the input was ("Valid YAML: 1 document"). */
      readonly summary: string;
      readonly warnings: readonly DataIssue[];
      /** What the output does not carry over from the input, and other things worth knowing. */
      readonly notes: readonly string[];
    };
