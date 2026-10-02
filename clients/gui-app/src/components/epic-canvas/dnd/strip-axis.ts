/**
 * The axis a header strip lays its items out along.
 *
 * The strip drag model is one-dimensional: it only ever sees a position along
 * the strip. This module is the one place that maps that position onto the
 * viewport - `x` for the horizontal strip at the top, `y` for a vertical strip
 * at a side - so the model, the geometry reads and the drag provider share one
 * definition of "along" (main) and "across" (cross).
 */
import type { PointLike, RectLike } from "@/components/epic-canvas/dnd/dnd";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";

export type StripAxisId = "x" | "y";

export interface StripAxis {
  readonly id: StripAxisId;
  /** Left for `x`, top for `y`. */
  readonly mainStart: (rect: RectLike) => number;
  /** Right for `x`, bottom for `y`. */
  readonly mainEnd: (rect: RectLike) => number;
  /** Width for `x`, height for `y`. */
  readonly mainExtent: (rect: RectLike) => number;
  /** Top for `x`, left for `y`. */
  readonly crossStart: (rect: RectLike) => number;
  /** Bottom for `x`, right for `y`. */
  readonly crossEnd: (rect: RectLike) => number;
  readonly pointerMain: (point: PointLike) => number;
  readonly pointerCross: (point: PointLike) => number;
  /** `scrollLeft` for `x`, `scrollTop` for `y`. */
  readonly scrollOffset: (element: HTMLElement) => number;
  readonly scrollBy: (element: HTMLElement, delta: number) => void;
  /**
   * `offsetLeft` for `x`, `offsetTop` for `y`: layout position, transforms
   * excluded.
   */
  readonly layoutOffset: (element: HTMLElement) => number;
  /**
   * The scroller's `scroll-padding` at the start and at the end of the axis
   * (`left` and `right`, or `top` and `bottom`), in px: the part of the
   * scrollport something else covers. 0 for `auto` or unset.
   */
  readonly scrollPadding: (style: CSSStyleDeclaration) => ScrollPadding;
}

export interface ScrollPadding {
  readonly start: number;
  readonly end: number;
}

/** A computed `scroll-padding-*` as px; `auto` and an unset value are 0. */
function paddingPx(value: string): number {
  return Number.parseFloat(value) || 0;
}

export const HORIZONTAL_STRIP_AXIS: StripAxis = {
  id: "x",
  mainStart: (rect) => rect.left,
  mainEnd: (rect) => rect.left + rect.width,
  mainExtent: (rect) => rect.width,
  crossStart: (rect) => rect.top,
  crossEnd: (rect) => rect.top + rect.height,
  pointerMain: (point) => point.x,
  pointerCross: (point) => point.y,
  scrollOffset: (element) => element.scrollLeft,
  scrollBy: (element, delta) => {
    element.scrollLeft += delta;
  },
  layoutOffset: (element) => element.offsetLeft,
  scrollPadding: (style) => ({
    start: paddingPx(style.scrollPaddingLeft),
    end: paddingPx(style.scrollPaddingRight),
  }),
};

export const VERTICAL_STRIP_AXIS: StripAxis = {
  id: "y",
  mainStart: (rect) => rect.top,
  mainEnd: (rect) => rect.top + rect.height,
  mainExtent: (rect) => rect.height,
  crossStart: (rect) => rect.left,
  crossEnd: (rect) => rect.left + rect.width,
  pointerMain: (point) => point.y,
  pointerCross: (point) => point.x,
  scrollOffset: (element) => element.scrollTop,
  scrollBy: (element, delta) => {
    element.scrollTop += delta;
  },
  layoutOffset: (element) => element.offsetTop,
  scrollPadding: (style) => ({
    start: paddingPx(style.scrollPaddingTop),
    end: paddingPx(style.scrollPaddingBottom),
  }),
};

export function stripAxisOf(id: StripAxisId): StripAxis {
  return id === "x" ? HORIZONTAL_STRIP_AXIS : VERTICAL_STRIP_AXIS;
}

/** The window edge a strip is docked to. */
export type StripEdge = "top" | EdgeSide;

/**
 * Which way the content lies from the strip on the strip's cross axis: +1
 * after it, -1 before it.
 */
export type ContentDirection = 1 | -1;

/**
 * The content direction for a strip docked to `edge`: +1 below a top strip
 * and right of a left strip, -1 left of a right strip.
 */
export function contentDirectionOf(edge: StripEdge): ContentDirection {
  return edge === "right" ? -1 : 1;
}

/**
 * Scroll the strip the least amount that brings `member` into view, instantly.
 * The end edge is tested first, so a member longer than the strip keeps its
 * end edge in view. The scroller's `scroll-padding` counts as covered: a strip
 * with a sticky header or an edge fade keeps the member clear of it, and one
 * with no scroll-padding reveals exactly to the edge. `displacement` is how far
 * the member is drawn from its place along the axis (a commit settling it),
 * which is taken off: what is revealed is where the member will be, not a
 * frame of its way there.
 */
export function revealMemberAlongAxis(
  scroller: HTMLElement,
  member: HTMLElement,
  axis: StripAxis,
  displacement: number,
): void {
  const memberBox = member.getBoundingClientRect();
  const viewBox = scroller.getBoundingClientRect();
  const padding = axis.scrollPadding(getComputedStyle(scroller));
  const pastEnd =
    axis.mainEnd(memberBox) -
    displacement -
    (axis.mainEnd(viewBox) - padding.end);
  const pastStart =
    axis.mainStart(viewBox) +
    padding.start -
    (axis.mainStart(memberBox) - displacement);
  if (pastEnd > 0) axis.scrollBy(scroller, pastEnd);
  else if (pastStart > 0) axis.scrollBy(scroller, -pastStart);
}

/**
 * Whether the pointer has been pulled out of the strip toward the content by
 * more than `thresholdPx`. `axis` is the STRIP's main axis, so the band
 * `bandStart..bandEnd` is measured on its cross axis. The far side of the strip
 * (between the strip and the window edge) never counts.
 */
export function pulledOutOfStrip(input: {
  readonly point: PointLike | null;
  readonly bandStart: number;
  readonly bandEnd: number;
  readonly contentDirection: ContentDirection;
  readonly axis: StripAxis;
  readonly thresholdPx: number;
}): boolean {
  if (input.point === null) return false;
  const cross = input.axis.pointerCross(input.point);
  return input.contentDirection === 1
    ? cross > input.bandEnd + input.thresholdPx
    : cross < input.bandStart - input.thresholdPx;
}
