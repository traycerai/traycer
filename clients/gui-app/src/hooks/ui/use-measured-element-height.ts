import { observedBorderBox } from "@/lib/resize-observer-box";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";

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
export function useMeasuredElementHeight(
  measureOnAttach: boolean,
): UseMeasuredElementHeightResult {
  const [element, updateElement] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  const visible = useTileBodyVisible();
  const initiallyMeasured = useRef(new WeakSet<HTMLDivElement>());
  const setElement = useCallback(
    (element: HTMLDivElement | null): void => {
      updateElement(element);
      if (!measureOnAttach || !visible || !element) return;
      if (initiallyMeasured.current.has(element)) return;
      initiallyMeasured.current.add(element);
      // The chat dock needs its inset before first paint. History has a CSS
      // fallback and stays observer-only; warm switches never re-read either.
      const nextHeight = Math.ceil(element.getBoundingClientRect().height);
      if (nextHeight > 0) setHeight(nextHeight);
    },
    [measureOnAttach, visible],
  );
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((entry) => entry.target === element);
      if (!entry) return;
      // Observer-delivered border-box sizes include padding without forcing
      // layout in the commit that shows or hides a retained surface.
      const nextHeight = Math.ceil(observedBorderBox(entry).blockSize);
      if (nextHeight <= 0) return;
      setHeight((current) => (current === nextHeight ? current : nextHeight));
    });
    observer.observe(element, { box: "border-box" });
    return () => observer.disconnect();
  }, [element]);
  return { setElement, element, height };
}
