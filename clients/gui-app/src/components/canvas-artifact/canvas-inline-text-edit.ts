import type { HtmlElement } from "@traycer/html-source";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import type { CanvasTextDraftTarget } from "./canvas-board-document";
import type { CanvasSelection } from "./canvas-selection-store";

export interface CanvasRetypeTarget extends CanvasTextDraftTarget {
  readonly textNodes?: readonly {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly index: number;
    readonly element: HtmlElement;
  }[];
}

export function canvasRetypeTarget(
  element: HtmlElement,
): CanvasRetypeTarget | null {
  const textNodes: NonNullable<CanvasRetypeTarget["textNodes"]>[number][] = [];
  let text = "";
  const visit = (node: HtmlElement): boolean => {
    if (
      !node.isUniqueSource ||
      node.isRawText ||
      node.isVoid ||
      node.endTag === null ||
      node.startTag === null
    )
      return false;
    let index = 0;
    for (const child of node.children) {
      if (child.kind === "element") {
        if (!visit(child)) return false;
      } else if (child.kind === "text") {
        const start = text.length;
        text += child.value;
        textNodes.push({
          start,
          end: text.length,
          text: child.value,
          index,
          element: node,
        });
        index++;
      }
    }
    return true;
  };
  return visit(element) && textNodes.length > 0
    ? { text, textNodeIndex: null, textNodes }
    : null;
}

export function canvasRetypeEdit(
  target: CanvasRetypeTarget,
  value: string,
  selection: CanvasSelection,
): { selection: CanvasSelection; edit: ArtboardEdit } | null {
  if (value === target.text) return null;
  if (target.textNodes === undefined)
    return {
      selection,
      edit:
        target.textNodeIndex === null
          ? { kind: "set-text-content", text: value }
          : {
              kind: "set-text-node",
              index: target.textNodeIndex,
              text: value,
              expectedText: target.text,
            },
    };
  let start = 0;
  while (
    start < target.text.length &&
    start < value.length &&
    target.text[start] === value[start]
  )
    start++;
  let end = target.text.length;
  let replacementEnd = value.length;
  while (
    end > start &&
    replacementEnd > start &&
    target.text[end - 1] === value[replacementEnd - 1]
  ) {
    end--;
    replacementEnd--;
  }
  // A replacement across inline boundaries has no unambiguous formatting owner.
  const matches = target.textNodes.filter(
    (node) => start >= node.start && end <= node.end,
  );
  if (matches.length !== 1) return null;
  const node = matches[0];
  const marker = node.element.startTag?.start;
  if (marker === undefined) return null;
  return {
    selection: {
      ...selection,
      element: {
        ...selection.element,
        marker,
        tid: node.element.effectiveTid,
        tagName: node.element.tagName,
        generated: false,
      },
    },
    edit: {
      kind: "set-text-node",
      index: node.index,
      expectedText: node.text,
      text:
        node.text.slice(0, start - node.start) +
        value.slice(start, replacementEnd) +
        node.text.slice(end - node.start),
    },
  };
}
