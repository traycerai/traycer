import { useLayoutEffect, useRef, type RefObject } from "react";

const PINNED_PROPERTIES = ["left", "top", "width", "height"] as const;

/**
 * Lays the open sheet over its slot. The slot is an empty `fixed` box that CSS
 * sizes against the surface; the sheet is `absolute`, and copies the slot's
 * box, measured from the sheet's own offset parent. The sheet cannot simply be
 * `fixed` itself: iOS WebKit draws no caret for an editor inside a fixed box
 * that resolves against a canvas tile, so the draft would be typed blind.
 *
 * Written straight to the element, before paint, so the sheet never shows at
 * a stale box; the slot is watched because the surface resizes under it when
 * the keyboard comes and goes.
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
      const origin = sheet.offsetParent;
      if (origin === null) return;
      const box = slot.getBoundingClientRect();
      const from = origin.getBoundingClientRect();
      sheet.style.left = `${box.left - from.left}px`;
      sheet.style.top = `${box.top - from.top}px`;
      sheet.style.width = `${box.width}px`;
      sheet.style.height = `${box.height}px`;
    };
    const observer = new ResizeObserver(pin);
    observer.observe(slot);
    pin();
    return () => {
      observer.disconnect();
      for (const property of PINNED_PROPERTIES) {
        sheet.style.removeProperty(property);
      }
    };
  }, [expanded]);

  return { slotRef, sheetRef };
}
