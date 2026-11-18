import { useLayoutEffect, useState } from "react";

export interface UseMeasuredElementHeightResult {
  readonly setElement: (element: HTMLDivElement | null) => void;
  readonly element: HTMLDivElement | null;
  readonly height: number;
}

/**
 * ResizeObserver-measured height of a callback-ref'd element, rounded up to
 * the nearest pixel. A callback ref (`setElement`, not a plain `useRef`) so
 * the measuring effect re-runs precisely when the underlying DOM node
 * attaches or detaches (conditional rendering, not just a resize) - a plain
 * ref would not re-fire for that transition. A non-positive reading is
 * ignored (height keeps its last known value) rather than collapsing
 * reserved layout space to zero.
 */
export function useMeasuredElementHeight(): UseMeasuredElementHeightResult {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const updateHeight = () => {
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      if (nextHeight <= 0) return;
      setHeight((current) => (current === nextHeight ? current : nextHeight));
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { setElement, element, height };
}
