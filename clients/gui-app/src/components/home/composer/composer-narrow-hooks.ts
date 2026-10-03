import { observedBorderBox } from "@/lib/resize-observer-box";
import {
  use,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type RefCallback,
} from "react";
import {
  ComposerNarrowContext,
  NARROW_BREAKPOINT_PX,
} from "@/components/home/composer/composer-narrow-context-internal";

export function useIsComposerNarrow(): boolean {
  return use(ComposerNarrowContext);
}

/**
 * Whether the composer's border box is under the narrow breakpoint. The
 * ResizeObserver writes the answer and the snapshot only returns it, so no
 * render forces layout; a store update still commits before paint. A
 * zero-width entry (a hidden, retained composer) keeps the last answer.
 */
export function useComposerNarrowObserver(): {
  ref: RefCallback<HTMLDivElement>;
  isNarrow: boolean;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((nextElement: HTMLDivElement | null) => {
    setElement((current) => (current === nextElement ? current : nextElement));
  }, []);
  const narrow = useRef(false);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (element === null || typeof ResizeObserver === "undefined") {
        return () => {};
      }
      const observer = new ResizeObserver((entries) => {
        const entry = entries.at(-1);
        const width =
          entry === undefined ? 0 : observedBorderBox(entry).inlineSize;
        if (width <= 0) return;
        narrow.current = width < NARROW_BREAKPOINT_PX;
        onStoreChange();
      });
      observer.observe(element, { box: "border-box" });
      return () => observer.disconnect();
    },
    [element],
  );
  const getSnapshot = useCallback(() => narrow.current, []);
  const isNarrow = useSyncExternalStore(subscribe, getSnapshot, () => false);

  return { ref, isNarrow };
}
