/**
 * Single-line text formatting, kept free of any rendering dependency.
 *
 * This lived in `lib/utils.ts` beside `cn()`, which pulls in the class merger
 * and its compiled tables. That was harmless while every caller was a
 * component, and
 * stopped being harmless when the chat find projection - a pure text pass -
 * became shared code: importing one string helper dragged the whole class-name
 * stack in behind it, and `lib/utils.ts` was one of only two edges keeping the
 * projection's dependency closure from being pure TypeScript.
 *
 * `lib/utils.ts` re-exports both symbols, so existing callers are unaffected
 * and there is exactly one implementation.
 */

export interface FormatSingleLineOptions {
  maxLength: number;
  ellipsis: string;
}

/**
 * Trim and collapse whitespace onto one line, WITHOUT a length cap. Returns the
 * empty string when the input has no non-whitespace characters.
 *
 * For text rendered into an element that already cuts itself to the width it
 * is given (`truncate`, `line-clamp-*`): that cut follows the reading width, so
 * a character cap in front of it could only end the text early on a wide
 * column. Use {@link formatSingleLine} where no layout does the cutting (an
 * accessible name, a search preview, a persisted log line).
 */
export function collapseToSingleLine(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/**
 * Trim, collapse whitespace, and truncate with an ellipsis. Returns the
 * empty string when the input has no non-whitespace characters.
 */
export function formatSingleLine(
  input: string,
  options: FormatSingleLineOptions,
): string {
  const singleLine = collapseToSingleLine(input);
  if (singleLine.length === 0) return "";
  const { maxLength, ellipsis } = options;
  if (singleLine.length <= maxLength) return singleLine;
  const cutoff = Math.max(0, maxLength - ellipsis.length);
  return `${singleLine.slice(0, cutoff)}${ellipsis}`;
}
