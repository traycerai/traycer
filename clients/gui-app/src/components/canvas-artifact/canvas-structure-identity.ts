import type {
  ArtboardEdit,
  ArtboardElementLocator,
} from "@traycer/protocol/host/epic/artboard-edit";
import type {
  CanvasElement,
  CanvasElementLocator,
} from "@/lib/sandbox/canvas-bridge";

type Identity = Pick<CanvasElement, "marker" | "tid" | "tagName">;
export function sameLayoutElement(a: Identity, b: Identity): boolean {
  if (a.tagName !== b.tagName) return false;
  if (a.marker !== null && b.marker !== null)
    return a.marker === b.marker && a.tid === b.tid;
  return a.tid !== null && a.tid === b.tid;
}
export function frameLocator(element: Identity): CanvasElementLocator | null {
  if (element.tid !== null) return { tid: element.tid };
  return element.marker === null ? null : { marker: element.marker };
}
export function sourceLocator(
  element: Identity,
): ArtboardElementLocator | null {
  if (element.marker !== null)
    return {
      kind: "position",
      startTagOffset: element.marker,
      tagName: element.tagName,
    };
  return element.tid === null ? null : { kind: "tid", tid: element.tid };
}
export const CANVAS_SIBLING_NOTE = "Select elements in the same container.";
export const CANVAS_LAYOUT_CHANGED_NOTE =
  "The page changed this layout. Select the elements again.";

export function isCanvasStructureEdit(edit: ArtboardEdit): boolean {
  return [
    "move-element",
    "set-box",
    "align-elements",
    "distribute-elements",
    "wrap-elements",
    "unwrap-element",
  ].includes(edit.kind);
}
