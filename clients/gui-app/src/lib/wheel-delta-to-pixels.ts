const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export function wheelDeltaToPixels(
  delta: number,
  deltaMode: number,
  pageSize: number,
  lineSize: number,
): number {
  if (deltaMode === DOM_DELTA_LINE) return delta * lineSize;
  if (deltaMode === DOM_DELTA_PAGE) return delta * pageSize;
  return delta;
}
