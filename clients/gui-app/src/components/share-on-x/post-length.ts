import { LINK_TOP_LEVEL_DOMAINS } from "@/components/share-on-x/link-top-level-domains";

/** X's limit for a post from a standard account. */
export const X_POST_LIMIT = 280;

/** Every link counts as this many characters on X, whatever its length. */
const LINK_WEIGHT = 23;

/**
 * What X may turn into a t.co link: an explicit http(s) URL, or a bare domain
 * (its last label captured), which is a link only when that label is a real
 * top-level domain.
 */
const LINK_PATTERN =
  /\bhttps?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+([a-z]{2,63})\b(?:\/[^\s]*)?/giu;

/**
 * Characters a link cannot end with: X leaves trailing punctuation out of the
 * link and counts it as text ("see https://x.com." links "https://x.com").
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"\u2019\u201D\]}>)]+$/u;

/**
 * A link and the punctuation after it, which X counts as text. A closing
 * parenthesis stays with the link while it balances one inside it, as in a
 * Wikipedia URL.
 */
function splitTrailing(match: string): readonly [string, string] {
  let link = match.replace(TRAILING_PUNCTUATION, "");
  let rest = match.slice(link.length);
  while (rest.startsWith(")")) {
    const opens = link.split("(").length - 1;
    const closes = link.split(")").length - 1;
    if (opens <= closes) break;
    link += ")";
    rest = rest.slice(1);
  }
  return [link, rest];
}

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

/** Every emoji counts as this many characters on X, however it is built. */
const EMOJI_WEIGHT = 2;

/**
 * An emoji with its presentation selector, skin tone, keycap or zero-width
 * joined parts, a flag (two regional indicators), or a lone pictograph.
 */
const EMOJI_PATTERN =
  /\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

function textWeight(text: string): number {
  let weight = 0;
  for (const char of text) {
    weight += codePointWeight(char.codePointAt(0) ?? 0);
  }
  return weight;
}

/** How long X will count `text` as, out of {@link X_POST_LIMIT}. */
export function xPostLength(text: string): number {
  let links = 0;
  const rest = text
    .normalize("NFC")
    .replace(LINK_PATTERN, (match, topLevel: string | undefined) => {
      if (
        topLevel !== undefined &&
        !LINK_TOP_LEVEL_DOMAINS.has(topLevel.toLowerCase())
      ) {
        return match;
      }
      links += 1;
      // The punctuation after a link stays in the text it is counted with.
      return splitTrailing(match)[1];
    });
  let weight = links * LINK_WEIGHT;
  const plain = rest.replace(EMOJI_PATTERN, (emoji) => {
    // A lone code point keeps its own weight, so a symbol such as "©"
    // still counts as the one character X counts it as.
    weight += [...emoji].length === 1 ? textWeight(emoji) : EMOJI_WEIGHT;
    return "";
  });
  return weight + textWeight(plain);
}

/** X's web intent that opens a new post with `text` filled in. */
export function xPostIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
