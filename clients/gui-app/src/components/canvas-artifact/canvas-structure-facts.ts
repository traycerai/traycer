import type { HtmlElement } from "@traycer/html-source";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type {
  CanvasLayoutNode,
  CanvasSiblingLayout,
} from "@/lib/sandbox/canvas-layout-bridge";
import {
  canvasSourceElement,
  type CanvasBoardDocument,
} from "./canvas-board-document";
import {
  CANVAS_LAYOUT_CHANGED_NOTE,
  CANVAS_SIBLING_NOTE,
  sameLayoutElement,
} from "./canvas-structure-identity";

const WRAP_PARENTS = new Set([
  "ul",
  "ol",
  "menu",
  "select",
  "optgroup",
  "datalist",
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "col",
  "colgroup",
  "caption",
  "p",
]);
const UNWRAP_TAGS = new Set([
  "html",
  "head",
  "body",
  "ul",
  "ol",
  "menu",
  "select",
  "optgroup",
  "dl",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
]);

export interface CanvasStructureFacts {
  readonly nodes: readonly CanvasLayoutNode[];
  readonly refusal: string | null;
  readonly wrapRefusal: string | null;
  readonly unwrapRefusal: string | null;
}
function matchesSource(node: CanvasLayoutNode, source: HtmlElement): boolean {
  return sameLayoutElement(node, {
    marker: source.startTag?.start ?? null,
    tid: source.effectiveTid,
    tagName: source.tagName,
  });
}
function sameSourceLayout(
  parent: HtmlElement,
  layout: CanvasSiblingLayout,
): boolean {
  if (parent.tagName !== layout.parent.tagName) return false;
  if (parent.startTag !== null && !matchesSource(layout.parent, parent))
    return false;
  const siblings = parent.children.filter((node) => node.kind === "element");
  // Positional edits describe the served tree, not a tree rearranged by a script.
  return (
    siblings.length === layout.siblings.length &&
    siblings.every((source, index) =>
      matchesSource(layout.siblings[index], source),
    )
  );
}
function wrapperRefusals(
  parent: HtmlElement,
  sources: readonly HtmlElement[],
): Pick<CanvasStructureFacts, "wrapRefusal" | "unwrapRefusal"> {
  const siblings = parent.children.filter((node) => node.kind === "element");
  const indices = sources
    .map((source) => siblings.indexOf(source))
    .sort((a, b) => a - b);
  const contiguous = indices.every(
    (value, index) => index === 0 || value === indices[index - 1] + 1,
  );
  let wrapRefusal: string | null = null;
  if (WRAP_PARENTS.has(parent.tagName))
    wrapRefusal =
      "This container cannot hold a group. Ask the agent to change it.";
  else if (!contiguous)
    wrapRefusal = "Select consecutive elements to group or wrap.";
  const first = sources[0];
  const unwrapRefusal =
    sources.length !== 1 ||
    UNWRAP_TAGS.has(first.tagName) ||
    first.isVoid ||
    first.isRawText ||
    first.endTag === null
      ? "Select a wrapper that can be ungrouped."
      : null;
  return { wrapRefusal, unwrapRefusal };
}
export function structureFacts(
  document: CanvasBoardDocument | null,
  elements: readonly CanvasElement[],
  layout: CanvasSiblingLayout | null,
): CanvasStructureFacts {
  const refuse = (message: string): CanvasStructureFacts => ({
    nodes: [],
    refusal: message,
    wrapRefusal: message,
    unwrapRefusal: message,
  });
  if (document === null || layout === null)
    return refuse("Opening element layout…");
  if (layout.truncated)
    return refuse("This container has too many elements to arrange here.");
  if (elements.some((element) => element.generated))
    return refuse("Ask the agent to change this element.");
  const sources = elements.map((element) =>
    canvasSourceElement(document, element),
  );
  if (sources.some((source) => source === null))
    return refuse(CANVAS_LAYOUT_CHANGED_NOTE);
  const first = sources.at(0);
  if (first === undefined || first === null) return refuse(CANVAS_SIBLING_NOTE);
  const parent = document.parsed.elements.find((item) =>
    item.children.includes(first),
  );
  if (
    parent === undefined ||
    sources.some(
      (source) => source === null || !parent.children.includes(source),
    )
  )
    return refuse(CANVAS_SIBLING_NOTE);
  if (!sameSourceLayout(parent, layout))
    return refuse(CANVAS_LAYOUT_CHANGED_NOTE);
  const nodes: CanvasLayoutNode[] = [];
  for (const element of elements) {
    const matches = layout.siblings.filter((node) =>
      sameLayoutElement(element, node),
    );
    if (matches.length !== 1) return refuse(CANVAS_SIBLING_NOTE);
    nodes.push(matches[0]);
  }
  return {
    nodes,
    refusal: null,
    ...wrapperRefusals(
      parent,
      sources.filter((source) => source !== null),
    ),
  };
}
