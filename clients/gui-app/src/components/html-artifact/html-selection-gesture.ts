interface Point {
  readonly x: number;
  readonly y: number;
}

export interface HtmlSelectionGesture extends Point {
  readonly pointerId: number;
  readonly dragged: boolean;
}

export function moveHtmlSelectionGesture(
  gesture: HtmlSelectionGesture,
  point: Point,
): HtmlSelectionGesture {
  return {
    ...gesture,
    dragged:
      gesture.dragged ||
      Math.hypot(point.x - gesture.x, point.y - gesture.y) >= 3,
  };
}

export function isHtmlSelectionClick(
  gesture: HtmlSelectionGesture,
  pointerId: number,
  point: Point,
): boolean {
  return (
    gesture.pointerId === pointerId &&
    !moveHtmlSelectionGesture(gesture, point).dragged
  );
}
