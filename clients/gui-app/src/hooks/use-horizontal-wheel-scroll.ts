import { useCallback, type WheelEvent } from "react";

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export function useHorizontalWheelScroll() {
  return useCallback((event: WheelEvent<HTMLElement>) => {
    const element = event.currentTarget;
    const maxScrollLeft = element.scrollWidth - element.clientWidth;
    if (maxScrollLeft <= 0) return;

    const deltaX = wheelDeltaToPixels(
      event.deltaX,
      event.deltaMode,
      element.clientWidth,
      element.clientHeight,
    );
    const deltaY = wheelDeltaToPixels(
      event.deltaY,
      event.deltaMode,
      element.clientWidth,
      element.clientHeight,
    );
    const delta =
      Math.abs(deltaX) >= Math.abs(deltaY) && deltaX !== 0 ? deltaX : deltaY;
    if (delta === 0) return;

    const nextScrollLeft = clamp(element.scrollLeft + delta, 0, maxScrollLeft);
    if (nextScrollLeft === element.scrollLeft) return;

    element.scrollLeft = nextScrollLeft;
    event.preventDefault();
  }, []);
}

function wheelDeltaToPixels(
  delta: number,
  deltaMode: number,
  pageSize: number,
  lineSize: number,
): number {
  if (deltaMode === DOM_DELTA_LINE) return delta * lineSize;
  if (deltaMode === DOM_DELTA_PAGE) return delta * pageSize;
  return delta;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
