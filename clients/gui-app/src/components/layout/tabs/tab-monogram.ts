const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The first `count` graphemes of `text`, trimmed; empty for blank text. */
export function firstGraphemes(
  text: string,
  count: number,
): ReadonlyArray<string> {
  const graphemes: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(text.trim())) {
    if (graphemes.length === count) break;
    graphemes.push(segment);
  }
  return graphemes;
}

/** The first grapheme of `word` that carries a letter or a digit. */
function firstSignificantGrapheme(word: string): string | null {
  for (const { segment } of graphemeSegmenter.segment(word)) {
    if (LETTER_OR_DIGIT.test(segment)) return segment;
  }
  return null;
}

/**
 * The collapsed rail tile's monogram: the first grapheme of the first word
 * that contains a letter or digit, plus the first grapheme of the second such
 * word when there is one, upper-cased where the script has case. Words made
 * only of emoji, symbols or punctuation are skipped. Returns `null` when the
 * title has no such word; callers never pass a placeholder title.
 */
export function tabMonogram(title: string): string | null {
  const graphemes: string[] = [];
  for (const { segment } of wordSegmenter.segment(title)) {
    if (graphemes.length === 2) break;
    const grapheme = firstSignificantGrapheme(segment);
    if (grapheme !== null) graphemes.push(grapheme);
  }
  if (graphemes.length === 0) return null;
  return graphemes.join("").toLocaleUpperCase();
}
