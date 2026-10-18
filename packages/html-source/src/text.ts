import {
  decodeMapped,
  mappedRange,
  normalizeWhitespace,
  type MappedText,
} from "./mapped-text";
import { locateElement } from "./source";
import type {
  ElementLocator,
  HtmlChild,
  HtmlTextNode,
  SourceRange,
} from "./types";

/** Read a literal subrange without splitting an entity or a normalized CRLF. */
export function textInSourceRange(
  text: string,
  node: HtmlTextNode,
  range: SourceRange,
): string | null {
  if (range.start < node.range.start || range.end > node.range.end) return null;
  const mapped = decodeMapped(
    text.slice(node.range.start, node.range.end),
    node.range.start,
    "text",
  );
  if (mapped.value !== node.value) return null;
  let result = "";
  for (let index = 0; index < mapped.ranges.length; index++) {
    const source = mapped.ranges[index];
    if (!source || source.end <= range.start || source.start >= range.end)
      continue;
    if (source.start < range.start || source.end > range.end) return null;
    result += mapped.value.charAt(index);
  }
  return result;
}

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
