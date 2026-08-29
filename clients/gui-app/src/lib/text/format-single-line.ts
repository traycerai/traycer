/**
 * Single-line text formatting, kept free of any rendering dependency.
 *
 * This lived in `lib/utils.ts` beside `cn()`, which imports `clsx` and
 * `tailwind-merge`. That was harmless while every caller was a component, and
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
 * Trim, collapse whitespace, and truncate with an ellipsis. Returns the
 * empty string when the input has no non-whitespace characters.
 */
export function formatSingleLine(
  input: string,
  options: FormatSingleLineOptions,
): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "";
  const singleLine = trimmed.replace(/\s+/g, " ");
  const { maxLength, ellipsis } = options;
  if (singleLine.length <= maxLength) return singleLine;
  const cutoff = Math.max(0, maxLength - ellipsis.length);
  return `${singleLine.slice(0, cutoff)}${ellipsis}`;
}
