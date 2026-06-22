import {
  use,
  useCallback,
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

export function useComposerNarrowObserver(): {
  ref: RefCallback<HTMLDivElement>;
  isNarrow: boolean;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((nextElement: HTMLDivElement | null) => {
    setElement(nextElement);
  }, []);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (element === null) return () => {};
      const observer = new ResizeObserver(onStoreChange);
      observer.observe(element);
      return () => {
        observer.disconnect();
      };
    },
    [element],
  );
  const getSnapshot = useCallback(() => {
    if (element === null) return false;
    return element.getBoundingClientRect().width < NARROW_BREAKPOINT_PX;
  }, [element]);
  const getServerSnapshot = useCallback(() => false, []);
  const isNarrow = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  return { ref, isNarrow };
}
