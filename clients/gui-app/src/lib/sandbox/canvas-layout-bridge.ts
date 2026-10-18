import { canvasRecord, parseCanvasBox, type CanvasBox } from "./canvas-bridge";

/** Bounded layout facts, deliberately excluding markup and text snapshots. */
export interface CanvasLayoutNode {
  readonly marker: number | null;
  readonly tid: string | null;
  readonly tagName: string;
  readonly box: CanvasBox;
  readonly position: string;
  /** Null when editing this inset would not translate the box by the same delta. */
  readonly left: number | null;
  readonly top: number | null;
  readonly cssWidth: number | null;
  readonly cssHeight: number | null;
  readonly transformed: boolean;
  readonly order: number;
  /** Explicit grid lines override the DOM order after a source move. */
  readonly gridPlacement: boolean;
}
export interface CanvasSiblingLayout {
  readonly parent: CanvasLayoutNode;
  readonly siblings: readonly CanvasLayoutNode[];
  readonly axis: "x" | "y";
  readonly reverse: boolean;
  readonly truncated: boolean;
}
function nullableCoordinate(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= 10_000_000)
  );
}
function layoutIdentity(
  value: Record<string, unknown>,
): Pick<
  CanvasLayoutNode,
  "marker" | "tid" | "tagName" | "position" | "transformed"
> | null {
  const { marker, tid, tagName, position, transformed } = value;
  if (
    marker !== null &&
    (typeof marker !== "number" || !Number.isSafeInteger(marker) || marker < 0)
  )
    return null;
  if (tid !== null && (typeof tid !== "string" || tid.length > 300))
    return null;
  if (
    typeof tagName !== "string" ||
    tagName.length > 40 ||
    typeof position !== "string" ||
    position.length > 40 ||
    typeof transformed !== "boolean"
  )
    return null;
  return { marker, tid, tagName, position, transformed };
}
function parseLayoutNode(value: unknown): CanvasLayoutNode | null {
  if (!canvasRecord(value)) return null;
  const identity = layoutIdentity(value);
  const { left, top, cssWidth, cssHeight, order, gridPlacement } = value;
  const box = parseCanvasBox(value.box);
  if (
    identity === null ||
    box === null ||
    !nullableCoordinate(left) ||
    !nullableCoordinate(top) ||
    !nullableCoordinate(cssWidth) ||
    !nullableCoordinate(cssHeight) ||
    typeof order !== "number" ||
    !Number.isSafeInteger(order) ||
    typeof gridPlacement !== "boolean"
  )
    return null;
  if (
    (cssWidth !== null && cssWidth < 0) ||
    (cssHeight !== null && cssHeight < 0)
  )
    return null;
  return { ...identity, left, top, cssWidth, cssHeight, box, order, gridPlacement };
}
export function parseCanvasSiblingLayout(
  value: unknown,
): CanvasSiblingLayout | null {
  if (
    !canvasRecord(value) ||
    !Array.isArray(value.siblings) ||
    value.siblings.length > 256
  )
    return null;
  const parent = parseLayoutNode(value.parent);
  if (
    parent === null ||
    (value.axis !== "x" && value.axis !== "y") ||
    typeof value.reverse !== "boolean" ||
    typeof value.truncated !== "boolean"
  )
    return null;
  const siblings: CanvasLayoutNode[] = [];
  for (const item of value.siblings) {
    const node = parseLayoutNode(item);
    if (node === null) return null;
    siblings.push(node);
  }
  return {
    parent,
    siblings,
    axis: value.axis,
    reverse: value.reverse,
    truncated: value.truncated,
  };
}
