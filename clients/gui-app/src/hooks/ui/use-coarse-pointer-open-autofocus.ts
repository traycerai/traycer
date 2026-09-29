import { useCallback, useRef, type RefObject } from "react";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

export interface CoarsePointerOpenAutoFocus {
  readonly contentRef: RefObject<HTMLDivElement | null>;
  readonly initialFocus: () => boolean | HTMLElement;
}

/** Touch opens retain existing focus, or focus the surface when WebKit left it on body. */
export function useCoarsePointerOpenAutoFocus(): CoarsePointerOpenAutoFocus {
  const coarsePointer = useCoarsePointer();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const initialFocus = useCallback((): boolean | HTMLElement => {
    if (!coarsePointer) return true;
    const active = document.activeElement;
    if (
      active !== null &&
      active !== document.body &&
      active !== document.documentElement
    )
      return false;
    return contentRef.current ?? true;
  }, [coarsePointer]);
  return { contentRef, initialFocus };
}
