import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Lays the open sheet over its slot, an empty `fixed` box that CSS sizes
 * against the surface. The sheet cannot be `fixed` itself: iOS WebKit draws
 * no caret for an editor inside a fixed box that resolves against a canvas
 * tile. The slot is watched because the surface resizes under it when the
 * keyboard comes and goes; the sheet's ancestors are watched because a
 * reflow around the card moves the sheet's origin, and a move cannot be
 * observed but the ancestor resizing with it can.
 *
 * The bottom edge is pinned and the top is a floor, not a fixed value: a pull
 * on the grabber holds the top lower through `--composer-sheet-top`.
 */
export function useComposerSheetPin(expanded: boolean): {
  slotRef: RefObject<HTMLDivElement | null>;
  sheetRef: RefObject<HTMLDivElement | null>;
} {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const sheet = sheetRef.current;
    if (!expanded || slot === null || sheet === null) return undefined;
    const pin = (): void => {
      const origin = sheet.offsetParent?.getBoundingClientRect();
      if (origin === undefined) return;
      const box = slot.getBoundingClientRect();
      const top = box.top - origin.top;
      Object.assign(sheet.style, {
        left: `${box.left - origin.left}px`,
        top: `max(${top}px, var(--composer-sheet-top, ${top}px))`,
        width: `${box.width}px`,
        bottom: `${origin.bottom - box.bottom}px`,
      });
    };
    const observer = new ResizeObserver(pin);
    observer.observe(slot);
    for (let up = sheet.parentElement; up !== null; up = up.parentElement) {
      observer.observe(up);
    }
    pin();
    return () => {
      observer.disconnect();
      Object.assign(sheet.style, { left: "", top: "", width: "", bottom: "" });
    };
  }, [expanded]);

  return { slotRef, sheetRef };
}
