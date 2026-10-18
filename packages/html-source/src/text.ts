import {
  decodeMapped,
  mappedRange,
  normalizeWhitespace,
  type MappedText,
} from "./mapped-text";
import { locateElement } from "./source";
import type { ElementLocator, HtmlChild, SourceRange } from "./types";

/** Best-effort source span of a decoded quote, possibly across inline elements. */
export function findLiteralText(
  text: string,
  locator: ElementLocator,
  quote: string,
): SourceRange | null {
  const located = locateElement(text, locator);
  if (!located.ok || !quote || located.element.isRawText) return null;
  const pending: HtmlChild[] = [...located.element.children].reverse();
  const mapped: MappedText = { value: "", ranges: [] };
  const chunks: string[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (node.kind === "element") {
      if (!node.isRawText) {
        for (let index = node.children.length - 1; index >= 0; index--) {
          const child = node.children[index];
          if (child) pending.push(child);
        }
      }
    } else if (node.kind === "text") {
      const decoded = decodeMapped(
        text.slice(node.range.start, node.range.end),
        node.range.start,
        "text",
      );
      if (decoded.value !== node.value) return null;
      chunks.push(decoded.value);
      for (const range of decoded.ranges) mapped.ranges.push(range);
    }
  }
  mapped.value = chunks.join("");
  let index = mapped.value.indexOf(quote);
  let target = mapped;
  let length = quote.length;
  if (index < 0) {
    target = normalizeWhitespace(mapped);
    const normalizedQuote = quote.replace(/\s+/gu, " ").trim();
    if (!normalizedQuote) return null;
    index = target.value.indexOf(normalizedQuote);
    length = normalizedQuote.length;
  }
  if (index < 0) return null;
  // Foster parenting can reorder source chunks. Such a match has no one span.
  const ranges = target.ranges.slice(index, index + length);
  if (
    ranges.some(
      (range, i) => i > 0 && range.start < (ranges[i - 1]?.start ?? 0),
    )
  )
    return null;
  return mappedRange(target, index, index + length, 0);
}
