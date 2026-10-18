import type { ArtboardEdit, ArtboardElementLocator, ArtboardElementPlacement } from "@traycer/protocol/host/epic/artboard-edit";
import type { CanvasBox, CanvasElement, CanvasElementLocator } from "@/lib/sandbox/canvas-bridge";
import type { CanvasLayoutNode, CanvasSiblingLayout } from "@/lib/sandbox/canvas-layout-bridge";
import { canvasSourceElement, type CanvasBoardDocument } from "./canvas-board-document";

export type CanvasAlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type CanvasResizeCorner = "nw" | "ne" | "sw" | "se";
type Identity = Pick<CanvasElement, "marker" | "tid" | "tagName">;
export function sameLayoutElement(a: Identity, b: Identity): boolean {
  return a.tid !== null && b.tid !== null ? a.tid === b.tid : a.marker !== null && a.marker === b.marker && a.tagName === b.tagName;
}
export function frameLocator(element: Identity): CanvasElementLocator | null {
  if (element.tid !== null) return { tid: element.tid };
  return element.marker === null ? null : { marker: element.marker };
}
export function sourceLocator(element: Identity): ArtboardElementLocator | null {
  if (element.tid !== null) return { kind: "tid", tid: element.tid };
  return element.marker === null ? null : { kind: "position", startTagOffset: element.marker, tagName: element.tagName };
}
export const CANVAS_SIBLING_NOTE = "Select elements in the same container.";
export const CANVAS_LAYOUT_CHANGED_NOTE = "The page changed this layout. Select the elements again.";
const WRAP_PARENTS = new Set(["ul", "ol", "menu", "select", "optgroup", "datalist", "dl", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "col", "colgroup", "caption", "p"]);
const UNWRAP_TAGS = new Set(["html", "head", "body", "ul", "ol", "menu", "select", "optgroup", "dl", "table", "thead", "tbody", "tfoot", "tr"]);

export interface CanvasStructureFacts {
  readonly nodes: readonly CanvasLayoutNode[];
  readonly refusal: string | null;
  readonly wrapRefusal: string | null;
  readonly unwrapRefusal: string | null;
}
export function structureFacts(document: CanvasBoardDocument | null, elements: readonly CanvasElement[], layout: CanvasSiblingLayout | null): CanvasStructureFacts {
  const refuse = (message: string): CanvasStructureFacts => ({ nodes: [], refusal: message, wrapRefusal: message, unwrapRefusal: message });
  if (document === null || layout === null) return refuse("Opening element layout…");
  if (layout.truncated) return refuse("This container has too many elements to arrange here.");
  if (elements.some((element) => element.generated)) return refuse("Ask the agent to change this element.");
  const sources = elements.map((element) => canvasSourceElement(document, element));
  if (sources.some((source) => source === null)) return refuse(CANVAS_LAYOUT_CHANGED_NOTE);
  const first = sources[0];
  if (first === undefined || first === null) return refuse(CANVAS_SIBLING_NOTE);
  const parent = document.parsed.elements.find((item) => item.children.includes(first));
  if (parent === undefined || sources.some((source) => source === null || !parent.children.includes(source))) return refuse(CANVAS_SIBLING_NOTE);
  if (parent.tagName !== layout.parent.tagName) return refuse(CANVAS_LAYOUT_CHANGED_NOTE);
  if (parent.startTag !== null && !sameLayoutElement(layout.parent, { marker: parent.startTag.start, tid: parent.effectiveTid, tagName: parent.tagName })) return refuse(CANVAS_LAYOUT_CHANGED_NOTE);
  const nodes: CanvasLayoutNode[] = [];
  for (const element of elements) {
    const matches = layout.siblings.filter((node) => sameLayoutElement(element, node));
    if (matches.length !== 1) return refuse(CANVAS_SIBLING_NOTE);
    nodes.push(matches[0]);
  }
  const siblings = parent.children.filter((node) => node.kind === "element");
  const indices = sources.map((source) => siblings.findIndex((node) => node === source)).sort((a, b) => a - b);
  const liveIndices = nodes.map((node) => layout.siblings.indexOf(node)).sort((a, b) => a - b);
  const contiguous = (positions: readonly number[]): boolean => positions.every((value, index) => index === 0 || value === positions[index - 1] + 1);
  let wrapRefusal: string | null = null;
  if (WRAP_PARENTS.has(parent.tagName)) wrapRefusal = "This container cannot hold a group. Ask the agent to change it.";
  else if (!contiguous(indices) || !contiguous(liveIndices)) wrapRefusal = "Select consecutive elements to group or wrap.";
  const unwrapRefusal = elements.length !== 1 || UNWRAP_TAGS.has(first.tagName) || first.isVoid || first.isRawText || first.endTag === null ? "Select a wrapper that can be ungrouped." : null;
  return { nodes, refusal: null, wrapRefusal, unwrapRefusal };
}
export function arrangementRefusal(nodes: readonly CanvasLayoutNode[], minimum: number): string | null {
  if (nodes.length < minimum) return `Select at least ${minimum} elements.`;
  if (nodes.some((node) => node.position !== "absolute" && node.position !== "relative")) return "Alignment needs elements positioned absolute or relative.";
  if (nodes.some((node) => node.transformed || node.left === null || node.top === null)) return "This layout cannot be aligned here. Ask the agent to change it.";
  return null;
}
function placement(node: CanvasLayoutNode, axis: "x" | "y", target: number): ArtboardElementPlacement | null {
  const locator = sourceLocator(node);
  const current = axis === "x" ? node.left : node.top;
  if (locator === null || current === null) return null;
  const value = current + target - node.box[axis];
  if (!Number.isFinite(value) || Math.abs(value) > 10_000_000) return null;
  return { locator, declarations: [{ property: axis === "x" ? "left" : "top", value: `${Math.round(value * 1000) / 1000}px` }] };
}
export function alignElements(nodes: readonly CanvasLayoutNode[], mode: CanvasAlignMode): ArtboardEdit | null {
  if (arrangementRefusal(nodes, 2) !== null) return null;
  const axis = mode === "left" || mode === "center" || mode === "right" ? "x" : "y";
  const dimension = axis === "x" ? "width" : "height";
  const start = Math.min(...nodes.map((node) => node.box[axis]));
  const end = Math.max(...nodes.map((node) => node.box[axis] + node.box[dimension]));
  const elements: ArtboardElementPlacement[] = [];
  for (const node of nodes) {
    let target = start;
    if (mode === "center" || mode === "middle") target = (start + end - node.box[dimension]) / 2;
    else if (mode === "right" || mode === "bottom") target = end - node.box[dimension];
    const item = placement(node, axis, target);
    if (item === null) return null;
    elements.push(item);
  }
  return { kind: "align-elements", mode, elements };
}
export function distributeElements(nodes: readonly CanvasLayoutNode[], axis: "x" | "y"): ArtboardEdit | null {
  if (arrangementRefusal(nodes, 3) !== null) return null;
  const sorted = [...nodes].sort((a, b) => a.box[axis] - b.box[axis]);
  const dimension = axis === "x" ? "width" : "height";
  const last = sorted[sorted.length - 1];
  const span = last.box[axis] + last.box[dimension] - sorted[0].box[axis];
  const gap = (span - sorted.reduce((sum, node) => sum + node.box[dimension], 0)) / (sorted.length - 1);
  const elements: ArtboardElementPlacement[] = [];
  let target = sorted[0].box[axis];
  for (const node of sorted) {
    const item = placement(node, axis, target);
    if (item === null) return null;
    elements.push(item);
    target += node.box[dimension] + gap;
  }
  return { kind: "distribute-elements", axis, elements };
}
export function resizeElement(node: CanvasLayoutNode, corner: CanvasResizeCorner, delta: { x: number; y: number }, ratio: boolean): { width: number; height: number; box: CanvasBox } | null {
  if (node.transformed || node.cssWidth === null || node.cssHeight === null || node.box.width <= 0 || node.box.height <= 0) return null;
  const insetX = Math.max(0, node.box.width - node.cssWidth);
  const insetY = Math.max(0, node.box.height - node.cssHeight);
  let width = Math.max(insetX, node.box.width + delta.x * (corner.endsWith("w") ? -1 : 1));
  let height = Math.max(insetY, node.box.height + delta.y * (corner.startsWith("n") ? -1 : 1));
  if (ratio) {
    const horizontal = width / node.box.width;
    const vertical = height / node.box.height;
    const chosen = Math.abs(horizontal - 1) >= Math.abs(vertical - 1) ? horizontal : vertical;
    const scale = Math.max(chosen, insetX / node.box.width, insetY / node.box.height);
    width = node.box.width * scale;
    height = node.box.height * scale;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width > 10_000_000 || height > 10_000_000) return null;
  return { width: Math.max(0, width - insetX), height: Math.max(0, height - insetY), box: { ...node.box, width, height } };
}
export function reorderTarget(layout: CanvasSiblingLayout, selected: Identity, point: { x: number; y: number }): { before: ArtboardElementLocator | null; marker: CanvasBox } | null {
  const parent = layout.parent.box;
  if (point.x < parent.x || point.y < parent.y || point.x > parent.x + parent.width || point.y > parent.y + parent.height) return null;
  const siblings = layout.siblings.filter((node) => !sameLayoutElement(node, selected));
  if (layout.truncated || siblings.length === 0 || siblings.some((node) => sourceLocator(node) === null)) return null;
  const axis = layout.axis;
  const dimension = axis === "x" ? "width" : "height";
  const sign = layout.reverse ? -1 : 1;
  const before = siblings.find((node) => point[axis] * sign < (node.box[axis] + node.box[dimension] / 2) * sign);
  const edge = before ?? siblings[siblings.length - 1];
  const atEnd = before === undefined;
  const coordinate = edge.box[axis] + ((atEnd !== layout.reverse) ? edge.box[dimension] : 0);
  const marker = axis === "x" ? { x: coordinate, y: edge.box.y, width: 2, height: edge.box.height } : { x: edge.box.x, y: coordinate, width: edge.box.width, height: 2 };
  return { before: before === undefined ? null : sourceLocator(before), marker };
}
