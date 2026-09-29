import { vi } from "vitest";

// The stubbed thumb-positioner width, matching the production pill thumb's
// `size-6` (1.5rem = 24px). Every other stubbed element is 400px wide.
const THUMB_WIDTH = 24;

/**
 * Enough of a layout for Base's slider to turn a pointer position into a
 * value, so a test can drag the real control.
 *
 * jsdom measures everything as zero, so a drag reports no movement at all and
 * a pointer test would pass against a slider that never moved. Every element
 * gets a 400px-wide box EXCEPT the thumb positioner, which needs its real
 * (much smaller) width: `thumbAlignment="edge"` (`ui/slider.tsx`) makes Base
 * read that width as real geometry (`SliderControl.js`'s `startPressing` sets
 * `insetThumbOffsetRef.current = thumbRect.width / 2` from it, then subtracts
 * that inset from both edges of the control's usable span) - stubbing it to
 * the same 400px as the control would zero that span out entirely
 * (400 - 2*200 = 0), so every drag divides by zero and never produces a
 * value. Pointer capture is also granted, which is what Base's
 * `SliderControl` checks before it treats a move as a slide. Returns the undo.
 */
export function stubSliderGeometry(): () => void {
  const rect = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element): DOMRect {
      const width =
        this.getAttribute("data-slot") === "slider-thumb-positioner"
          ? THUMB_WIDTH
          : 400;
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 16,
        width,
        height: 16,
        toJSON: () => ({}),
      };
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
