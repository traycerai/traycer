import { vi } from "vitest";

/**
 * Enough of a layout for Radix's slider to turn a pointer position into a
 * value, so a test can drag the real control.
 *
 * jsdom measures everything as zero, so a drag reports no movement at all and a
 * pointer test would pass against a slider that never moved. The track is given
 * a 400px box and pointer capture is granted, which is what Radix's
 * `onPointerMove` checks before it treats a move as a slide. Returns the undo.
 */
export function stubSliderGeometry(): () => void {
  const rect = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 16,
      width: 400,
      height: 16,
      toJSON: () => ({}),
    });
  const element: {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
    hasPointerCapture?: (pointerId: number) => boolean;
  } = Element.prototype;
  const previous = {
    set: element.setPointerCapture,
    release: element.releasePointerCapture,
    has: element.hasPointerCapture,
  };
  element.setPointerCapture = () => undefined;
  element.releasePointerCapture = () => undefined;
  element.hasPointerCapture = () => true;
  return () => {
    rect.mockRestore();
    element.setPointerCapture = previous.set;
    element.releasePointerCapture = previous.release;
    element.hasPointerCapture = previous.has;
  };
}

/** The x for stop `index` of `count` on the 400px track above. */
export function stopX(index: number, count: number): number {
  return (index / (count - 1)) * 400;
}
