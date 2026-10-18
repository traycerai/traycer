const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` split so its last `tailLength` characters can stay whole while the
 * rest shrinks: `head` is empty when the whole text is the tail. Counted in
 * graphemes, so an emoji or a combining mark is never cut in two.
 */
export function splitForMiddleTruncation(
  text: string,
  tailLength: number,
): { readonly head: string; readonly tail: string } {
  const parts = Array.from(graphemes.segment(text), (part) => part.segment);
  if (parts.length <= tailLength) return { head: "", tail: text };
  return {
    head: parts.slice(0, parts.length - tailLength).join(""),
    tail: parts.slice(parts.length - tailLength).join(""),
  };
}
