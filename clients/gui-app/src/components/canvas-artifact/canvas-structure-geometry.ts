import type {
  ArtboardEdit,
  ArtboardElementLocator,
  ArtboardElementPlacement,
} from "@traycer/protocol/host/epic/artboard-edit";
import type { CanvasBox, CanvasElement } from "@/lib/sandbox/canvas-bridge";
import type {
  CanvasLayoutNode,
  CanvasSiblingLayout,
} from "@/lib/sandbox/canvas-layout-bridge";

export type CanvasAlignMode =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom";
export type CanvasResizeCorner = "nw" | "ne" | "sw" | "se";
import { sameLayoutElement, sourceLocator } from "./canvas-structure-identity";
export {
  CANVAS_LAYOUT_CHANGED_NOTE,
  CANVAS_SIBLING_NOTE,
  sameLayoutElement,
  sourceLocator,
  frameLocator,
} from "./canvas-structure-identity";
export {
  structureFacts,
  type CanvasStructureFacts,
} from "./canvas-structure-facts";

export function arrangementRefusal(
  nodes: readonly CanvasLayoutNode[],
  minimum: number,
): string | null {
  if (nodes.length < minimum) return `Select at least ${minimum} elements.`;
  if (
    nodes.some(
      (node) => node.position !== "absolute" && node.position !== "relative",
    )
  )
    return "Ask the agent to arrange these elements in this layout.";
  if (
    nodes.some(
      (node) => node.transformed || node.left === null || node.top === null,
    )
  )
    return "This layout cannot be aligned here. Ask the agent to change it.";
  return null;
}
function placement(
  node: CanvasLayoutNode,
  axis: "x" | "y",
  target: number,
): ArtboardElementPlacement | null {
  const locator = sourceLocator(node);
  const current = axis === "x" ? node.left : node.top;
  if (locator === null || current === null) return null;
  const value = current + target - node.box[axis];
  if (!Number.isFinite(value) || Math.abs(value) > 10_000_000) return null;
  return {
    locator,
    declarations: [
      {
        property: axis === "x" ? "left" : "top",
        value: `${Math.round(value * 1000) / 1000}px`,
      },
    ],
  };
}
export function alignElements(
  nodes: readonly CanvasLayoutNode[],
  mode: CanvasAlignMode,
): ArtboardEdit | null {
  if (arrangementRefusal(nodes, 2) !== null) return null;
  const axis =
    mode === "left" || mode === "center" || mode === "right" ? "x" : "y";
  const dimension = axis === "x" ? "width" : "height";
  const start = Math.min(...nodes.map((node) => node.box[axis]));
  const end = Math.max(
    ...nodes.map((node) => node.box[axis] + node.box[dimension]),
  );
  const elements: ArtboardElementPlacement[] = [];
  for (const node of nodes) {
    let target = start;
    if (mode === "center" || mode === "middle")
      target = (start + end - node.box[dimension]) / 2;
    else if (mode === "right" || mode === "bottom")
      target = end - node.box[dimension];
    const item = placement(node, axis, target);
    if (item === null) return null;
    elements.push(item);
  }
  return { kind: "align-elements", mode, elements };
}
export function distributeElements(
  nodes: readonly CanvasLayoutNode[],
  axis: "x" | "y",
): ArtboardEdit | null {
  if (arrangementRefusal(nodes, 3) !== null) return null;
  const sorted = [...nodes].sort((a, b) => a.box[axis] - b.box[axis]);
  const dimension = axis === "x" ? "width" : "height";
  const last = sorted[sorted.length - 1];
  const span = last.box[axis] + last.box[dimension] - sorted[0].box[axis];
  const gap =
    (span - sorted.reduce((sum, node) => sum + node.box[dimension], 0)) /
    (sorted.length - 1);
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
export function resizeElement(
  node: CanvasLayoutNode,
  corner: CanvasResizeCorner,
  delta: { x: number; y: number },
  ratio: boolean,
): { width: number; height: number; box: CanvasBox } | null {
  if (
    node.transformed ||
    node.cssWidth === null ||
    node.cssHeight === null ||
    node.box.width <= 0 ||
    node.box.height <= 0
  )
    return null;
  const insetX = Math.max(0, node.box.width - node.cssWidth);
  const insetY = Math.max(0, node.box.height - node.cssHeight);
  let width = Math.max(
    insetX,
    node.box.width + delta.x * (corner.endsWith("w") ? -1 : 1),
  );
  let height = Math.max(
    insetY,
    node.box.height + delta.y * (corner.startsWith("n") ? -1 : 1),
  );
  if (ratio) {
    const horizontal = width / node.box.width;
    const vertical = height / node.box.height;
    const chosen =
      Math.abs(horizontal - 1) >= Math.abs(vertical - 1)
        ? horizontal
        : vertical;
    const scale = Math.max(
      chosen,
      insetX / node.box.width,
      insetY / node.box.height,
    );
    width = node.box.width * scale;
    height = node.box.height * scale;
  }
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width > 10_000_000 ||
    height > 10_000_000
  )
    return null;
  return {
    width: Math.max(0, width - insetX),
    height: Math.max(0, height - insetY),
    box: { ...node.box, width, height },
  };
}
export function reorderTarget(
  layout: CanvasSiblingLayout,
  selected: Pick<CanvasElement, "marker" | "tid" | "tagName">,
  point: { x: number; y: number },
): { before: ArtboardElementLocator | null; marker: CanvasBox } | null {
  if (reorderRefusal(layout) !== null) return null;
  const parent = layout.parent.box;
  if (
    point.x < parent.x ||
    point.y < parent.y ||
    point.x > parent.x + parent.width ||
    point.y > parent.y + parent.height
  )
    return null;
  const siblings = layout.siblings.filter(
    (node) => !sameLayoutElement(node, selected),
  );
  if (
    layout.truncated ||
    siblings.length === 0 ||
    siblings.some((node) => sourceLocator(node) === null)
  )
    return null;
  const axis = layout.axis;
  const dimension = axis === "x" ? "width" : "height";
  const sign = layout.reverse ? -1 : 1;
  const before = siblings.find(
    (node) =>
      point[axis] * sign < (node.box[axis] + node.box[dimension] / 2) * sign,
  );
  const edge = before ?? siblings[siblings.length - 1];
  const atEnd = before === undefined;
  const coordinate =
    edge.box[axis] + (atEnd !== layout.reverse ? edge.box[dimension] : 0);
  const marker =
    axis === "x"
      ? { x: coordinate, y: edge.box.y, width: 2, height: edge.box.height }
      : { x: edge.box.x, y: coordinate, width: edge.box.width, height: 2 };
  return {
    before: before === undefined ? null : sourceLocator(before),
    marker,
  };
}

export function reorderRefusal(layout: CanvasSiblingLayout): string | null {
  if (layout.truncated || layout.siblings.length < 2)
    return "Select an element with siblings to reorder.";
  const axis = layout.axis;
  const dimension = axis === "x" ? "width" : "height";
  const cross = axis === "x" ? "y" : "x";
  const crossSize = axis === "x" ? "height" : "width";
  const sign = layout.reverse ? -1 : 1;
  const siblings = layout.siblings;
  const oneLane =
    Math.max(...siblings.map((node) => node.box[cross])) <
    Math.min(...siblings.map((node) => node.box[cross] + node.box[crossSize]));
  if (
    layout.parent.transformed ||
    !oneLane ||
    siblings.some((node, index) => {
      if (
        node.transformed ||
        node.order !== siblings[0].order ||
        node.gridPlacement ||
        !["static", "relative"].includes(node.position) ||
        node.marker === null ||
        node.box[dimension] <= 0
      )
        return true;
      if (index === 0) return false;
      const previous = siblings[index - 1];
      return sign > 0
        ? node.box[axis] < previous.box[axis] + previous.box[dimension]
        : node.box[axis] + node.box[dimension] > previous.box[axis];
    })
  )
    return "Reorder elements in a single row or column. Ask the agent to change this layout.";
  return null;
}
