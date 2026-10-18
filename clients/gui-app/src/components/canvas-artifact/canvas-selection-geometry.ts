import type { CanvasBox } from "@/lib/sandbox/canvas-bridge";

export interface CanvasFrameTransform {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export function transformCanvasBox(
  box: CanvasBox,
  transform: CanvasFrameTransform,
): CanvasBox {
  return {
    x: transform.x + box.x * transform.scaleX,
    y: transform.y + box.y * transform.scaleY,
    width: box.width * transform.scaleX,
    height: box.height * transform.scaleY,
  };
}

export function clipCanvasBox(
  box: CanvasBox,
  viewport: CanvasBox,
): CanvasBox | null {
  const x = Math.max(box.x, viewport.x);
  const y = Math.max(box.y, viewport.y);
  const right = Math.min(box.x + box.width, viewport.x + viewport.width);
  const bottom = Math.min(box.y + box.height, viewport.y + viewport.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

/** Four transparent shields leave only the selected element available to text drag. */
export function canvasSelectionShields(
  selection: CanvasBox | null,
  width: number,
  height: number,
): readonly CanvasBox[] {
  const viewport = { x: 0, y: 0, width, height };
  const box = selection === null ? null : clipCanvasBox(selection, viewport);
  if (box === null) return [viewport];
  return [
    { x: 0, y: 0, width, height: box.y },
    { x: 0, y: box.y, width: box.x, height: box.height },
    {
      x: box.x + box.width,
      y: box.y,
      width: width - box.x - box.width,
      height: box.height,
    },
    { x: 0, y: box.y + box.height, width, height: height - box.y - box.height },
  ].filter((rect) => rect.width > 0 && rect.height > 0);
}
