import { useCallback, useRef, type RefObject } from "react";

import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

export interface CoarsePointerOpenAutoFocus {
  /** Attach to the popover content, the fallback focus destination. */
  readonly contentRef: RefObject<HTMLDivElement | null>;
  /** Pass to the layer's `onOpenAutoFocus`. */
  readonly onOpenAutoFocus: (event: Event) => void;
}

/** On coarse pointer, decline Radix autofocus when focus already rests (trigger must survive the open). */
export function useCoarsePointerOpenAutoFocus(): CoarsePointerOpenAutoFocus {
  const coarsePointer = useCoarsePointer();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const onOpenAutoFocus = useCallback(
    (event: Event): void => {
      if (!coarsePointer) return;
      // Read before Radix moves anything: this is where the opening gesture left focus.
      const active = document.activeElement;
      const focusRests =
        active !== null &&
        active !== document.body &&
        active !== document.documentElement;
      if (focusRests) {
        event.preventDefault();
        return;
      }
      const content = contentRef.current;
      if (content === null) return;
      event.preventDefault();
      content.focus();
    },
    [coarsePointer],
  );
  return { contentRef, onOpenAutoFocus };
}
