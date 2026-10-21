import { normalizeWhitespace } from "./mapped-text";
import { locateElement } from "./source";
import { textInSourceRange } from "./text";
import type { HtmlChild } from "./types";

export type CommentAnchorQuery =
  | { kind: "artifact" }
  | { kind: "element"; elementId: string }
  | { kind: "text"; elementId: string; quotedText: string };

function normalizedText(value: string): string {
  return normalizeWhitespace({
    value,
    ranges: Array.from({ length: value.length }, (_, start) => ({
      start,
      end: start + 1,
    })),
  }).value;
}

function decodedContent(source: string, children: HtmlChild[]): string {
  return children
    .map((child) => {
      if (child.kind === "text") {
        // Raw-text elements and <pre>'s leading newline already have their
        // browser text in the parsed node when a literal mapping is unavailable.
        return textInSourceRange(source, child, child.range) ?? child.value;
      }
      return child.kind === "element" && child.tagName !== "template"
        ? decodedContent(source, child.children)
        : "";
    })
    .join("");
}

/** Anchors follow the element and quote, never the offsets of an older edit. */
export function commentAnchorStatus(
  source: string,
  anchor: CommentAnchorQuery,
): "present" | "missing" {
  if (anchor.kind === "artifact") return "present";
  try {
    // locateElement parses the source and refuses duplicate/reconstructed ids.
    const located = locateElement(source, {
      kind: "tid",
      tid: anchor.elementId,
    });
    if (!located.ok) return "missing";
    if (anchor.kind === "element") return "present";
    const quote = normalizedText(anchor.quotedText).trim();
    if (!quote) return "missing";
    return normalizedText(
      decodedContent(source, located.element.children),
    ).includes(quote)
      ? "present"
      : "missing";
  } catch {
    return "missing";
  }
}
