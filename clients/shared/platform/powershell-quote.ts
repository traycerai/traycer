// PowerShell 5.1 treats ASCII `'` and U+2018–U+201B as single-quote
// delimiters. Doubling every one of those inside a single-quoted literal is
// the documented escape; doubling only ASCII `'` ends the literal early when
// a path contains a smart quote.

const POWERSHELL_SINGLE_QUOTE_RE = /['‘-‛]/g;

/** PowerShell single-quoted literal; doubles ASCII `'` and U+2018–U+201B. */
export function powershellSingleQuoted(value: string): string {
  return `'${value.replace(POWERSHELL_SINGLE_QUOTE_RE, "$&$&")}'`;
}
