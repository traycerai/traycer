/** X's limit for a post from a standard account. */
export const X_POST_LIMIT = 280;

/** Every link counts as this many characters on X, whatever its length. */
const LINK_WEIGHT = 23;

/**
 * Links X turns into t.co links: explicit http(s) URLs, and bare domains on
 * the top-level domains our ready-made lines and most edits use.
 */
const LINK_PATTERN =
  /\bhttps?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+(?:ai|app|co|com|dev|io|net|org|sh)\b(?:\/[^\s]*)?/giu;

/**
 * The code point ranges X weighs as one character; everything else (CJK,
 * most emoji) weighs two. Taken from X's own counting configuration.
 */
const SINGLE_WEIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

function codePointWeight(codePoint: number): number {
  return SINGLE_WEIGHT_RANGES.some(
    ([start, end]) => codePoint >= start && codePoint <= end,
  )
    ? 1
    : 2;
}

/** How long X will count `text` as, out of {@link X_POST_LIMIT}. */
export function xPostLength(text: string): number {
  let links = 0;
  const rest = text.normalize("NFC").replace(LINK_PATTERN, () => {
    links += 1;
    return "";
  });
  let weight = links * LINK_WEIGHT;
  for (const char of rest) {
    weight += codePointWeight(char.codePointAt(0) ?? 0);
  }
  return weight;
}

/** X's web intent that opens a new post with `text` filled in. */
export function xPostIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
