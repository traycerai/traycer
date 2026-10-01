import { useLayoutEffect, useState } from "react";

export interface UseIsTextTruncatedResult<T extends HTMLElement> {
  /** A callback ref: the element to measure, whichever one is mounted now. */
  readonly ref: (element: T | null) => void;
  readonly isTruncated: boolean;
}

/**
 * Measures whether an element's text is actually ellipsized (`scrollWidth >
 * clientWidth`), so a tooltip can be gated on real overflow instead of
 * unconditionally repeating already-visible text. Re-measures whenever
 * `content` changes and whenever the element itself resizes.
 *
 * The element is held as state through a callback ref, not read off a ref
 * object once, because a caller's subtree can REPLACE it with the same text:
 * a `TooltipWrapper` gated on this very answer swaps its Slot for a Tooltip
 * the moment the text truncates, which remounts the child. An observer on the
 * old node then reports it detached (0 x 0, "not truncated") and never sees
 * the new one (G4).
 */
export function useIsTextTruncated<T extends HTMLElement>(
  content: string,
): UseIsTextTruncatedResult<T> {
  const [element, setElement] = useState<T | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    if (element === null) return;
    const el = element;
    function measure(): void {
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [element, content]);

  return { ref: setElement, isTruncated };
}
