import type { HtmlChild } from "@traycer/html-source";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import {
  canvasSourceElement,
  type CanvasBoardDocument,
  type CanvasTextDraftTarget,
} from "./canvas-board-document";
import {
  sameCanvasElement,
  type CanvasSelection,
} from "./canvas-selection-store";

export const CANVAS_SCRIPT_TEXT_NOTE =
  "This text was changed by a script. Ask the agent to change it.";

/** DOM textContent offsets count decoded text, including nested elements, but not comments. */
function sourceTextContent(node: HtmlChild): string {
  const chunks: string[] = [];
  const queue: HtmlChild[] = [node];
  while (queue.length > 0) {
    const child = queue.pop();
    if (child?.kind === "text") chunks.push(child.value);
    else if (child?.kind === "element")
      for (const nested of [...child.children].reverse()) queue.push(nested);
  }
  return chunks.join("");
}

export function canvasRangeRefusal(
  document: CanvasBoardDocument | null,
  selection: CanvasSelection,
): string | null {
  if (document === null || document.sha256 !== selection.servedSha256)
    return "Wait for the artboard to finish loading.";
  const source = canvasSourceElement(document, selection.element);
  const range = selection.textRange;
  if (
    source === null ||
    range === null ||
    !sameCanvasElement(selection.element, range.element)
  )
    return CANVAS_SCRIPT_TEXT_NOTE;
  const text = sourceTextContent(source);
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start ||
    range.end > text.length ||
    text.slice(range.start, range.end) !== range.quote
  )
    return CANVAS_SCRIPT_TEXT_NOTE;
  return null;
}

export function canvasLiveText(
  target: CanvasTextDraftTarget,
  element: CanvasElement,
): string | null {
  const snapshot = element.textSnapshot;
  if (snapshot === undefined || snapshot === null) return null;
  if (target.textNodeIndex === null)
    return snapshot.textOnly ? snapshot.content : null;
  // Retyping mixed content is supported only for its single immediate text node.
  return snapshot.nodes.length === 1
    ? (snapshot.nodes.at(target.textNodeIndex) ?? null)
    : null;
}
