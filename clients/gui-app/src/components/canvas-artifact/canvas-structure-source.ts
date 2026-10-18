import type { HtmlElement, SourceRange } from "@traycer/html-source";
import type { CanvasBoardDocument } from "./canvas-board-document";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const TABLE_FAMILY = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "col", "colgroup", "caption",
]);
const WRAP_PARENTS = new Set([
  "ul", "ol", "menu", "select", "optgroup", "datalist", "dl", "p", ...TABLE_FAMILY,
]);
const UNWRAP_TAGS = new Set([
  "html", "head", "body", "ul", "ol", "menu", "select", "optgroup", "dl",
  "table", "thead", "tbody", "tfoot", "tr",
]);
const SOURCE_NOTE = "Ask the agent to change these elements before rearranging them.";

function literalRange(element: HtmlElement): SourceRange | null {
  if (element.startTag === null || !element.isUniqueSource) return null;
  const end = element.isVoid ? element.startTag.end : element.endTag?.end;
  return end === undefined ? null : { start: element.startTag.start, end };
}
function literalSubtree(element: HtmlElement): boolean {
  const range = literalRange(element);
  if (range === null) return false;
  return element.children.every((child) => {
    const childRange = child.kind === "element" ? literalRange(child) : child.range;
    return childRange !== null && childRange.start >= range.start &&
      childRange.end <= range.end && (child.kind !== "element" || literalSubtree(child));
  });
}
function foreignContext(
  element: HtmlElement,
  parents: ReadonlyMap<HtmlElement, HtmlElement>,
): boolean {
  for (let node: HtmlElement | undefined = element; node !== undefined; node = parents.get(node)) {
    if (node.namespaceURI !== HTML_NAMESPACE) return true;
  }
  return false;
}
function moveRefusal(parent: HtmlElement, siblings: readonly HtmlElement[]): string | null {
  if (parent.isRawText || parent.tagName === "template" ||
    TABLE_FAMILY.has(parent.tagName) || parent.namespaceURI !== HTML_NAMESPACE)
    return "Ask the agent to reorder elements in this container.";
  // A drag can end at the container's closing tag or before any sibling.
  if (literalRange(parent) === null || parent.endTag === null || !siblings.every(literalSubtree))
    return SOURCE_NOTE;
  return null;
}
function wrapRefusal(parent: HtmlElement, sources: readonly HtmlElement[], siblings: readonly HtmlElement[]): string | null {
  if (WRAP_PARENTS.has(parent.tagName))
    return "This container cannot hold a group. Ask the agent to change it.";
  if (!sources.every(literalSubtree)) return SOURCE_NOTE;
  const indices = sources.map((source) => siblings.indexOf(source)).sort((a, b) => a - b);
  return indices.every((value, index) => index === 0 || value === indices[index - 1] + 1)
    ? null : "Select consecutive elements to group or wrap.";
}

export function canvasSourceStructureRefusals(
  document: CanvasBoardDocument,
  parent: HtmlElement,
  sources: readonly HtmlElement[],
): { moveRefusal: string | null; wrapRefusal: string | null; unwrapRefusal: string | null } {
  const parents = new Map<HtmlElement, HtmlElement>();
  for (const element of document.parsed.elements) {
    for (const child of element.children) {
      if (child.kind === "element") parents.set(child, element);
    }
  }
  if (parent.startTag !== null && !parent.isUniqueSource)
    return { moveRefusal: SOURCE_NOTE, wrapRefusal: SOURCE_NOTE, unwrapRefusal: SOURCE_NOTE };
  const siblings = parent.children.filter((node) => node.kind === "element");
  const first = sources[0];
  return {
    moveRefusal: moveRefusal(parent, siblings),
    wrapRefusal: foreignContext(parent, parents) ? SOURCE_NOTE : wrapRefusal(parent, sources, siblings),
    unwrapRefusal: sources.length !== 1 || UNWRAP_TAGS.has(first.tagName) ||
      first.isVoid || first.isRawText || foreignContext(first, parents) || !literalSubtree(first)
      ? "Select a wrapper that can be ungrouped." : null,
  };
}
