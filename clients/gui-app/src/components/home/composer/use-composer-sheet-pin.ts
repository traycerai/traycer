import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Lays the open sheet over its slot, an empty `fixed` box that CSS sizes
 * against the surface. The sheet cannot be `fixed` itself: iOS WebKit draws
 * no caret for an editor inside a fixed box that resolves against a canvas
 * tile. The slot is watched because the surface resizes under it when the
 * keyboard comes and goes.
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
      Object.assign(sheet.style, {
        left: `${box.left - origin.left}px`,
        top: `${box.top - origin.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
    };
    const observer = new ResizeObserver(pin);
    observer.observe(slot);
    pin();
    return () => {
      observer.disconnect();
      Object.assign(sheet.style, { left: "", top: "", width: "", height: "" });
    };
  }, [expanded]);

  return { slotRef, sheetRef };
}
