import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface UseIsTextTruncatedResult<T extends HTMLElement> {
  readonly ref: RefObject<T | null>;
  readonly isTruncated: boolean;
}

/**
 * Measures whether an element's text is actually ellipsized (`scrollWidth >
 * clientWidth`), so a tooltip can be gated on real overflow instead of
 * unconditionally repeating already-visible text. Re-measures whenever
 * `content` changes and whenever the element itself resizes.
 */
export function useIsTextTruncated<T extends HTMLElement>(
  content: string,
): UseIsTextTruncatedResult<T> {
  const ref = useRef<T>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    function measure(): void {
      if (el === null) return;
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [content]);

  return { ref, isTruncated };
}
