/**
 * The whitespace shape chat find counts on: line endings unified, trailing
 * spaces dropped, runs of spaces collapsed, blank runs capped at one empty
 * line. Every text that is counted and every mirror a block renders for the
 * painter goes through this, so a hit the counter sees always has a range the
 * painter can find.
 */
export function normalizeSearchableText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
