/** Single-line text formatting, kept free of any rendering dependency. */

export interface FormatSingleLineOptions {
  maxLength: number;
  ellipsis: string;
}

/**
 * Trim, collapse whitespace, and truncate with an ellipsis.
 * Returns the empty string when the input has no non-whitespace characters.
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
