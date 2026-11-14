/**
 * Size limits for the YAML and XML operations, apart from the parsers so a page can show them
 * without loading a parser. Input over a limit is refused, never cut.
 */

export const YAML_LIMITS = {
  /** Characters of input accepted. */
  inputChars: 2_000_000,
  /** Characters of output produced; alias expansion can make output far larger than input. */
  outputChars: 20_000_000,
  /** Nesting depth converted. */
  depth: 200,
  /** Problems listed. */
  issues: 50,
} as const;

export const XML_LIMITS = { inputChars: 10_000_000, depth: 1_000, attributes: 10_000 } as const;
