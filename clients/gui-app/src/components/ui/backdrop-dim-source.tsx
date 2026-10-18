import { useLayoutEffect, useState, type ReactNode } from "react";

import {
  useBackdropDimStore,
  type BackdropStrength,
} from "@/stores/layout/backdrop-dim-store";

/**
 * Publishes the overlay it is rendered in as an open modal backdrop of
 * `strength` (`backdrop-dim-store.ts`), for as long as the overlay is mounted,
 * and whether it is playing its exit, read off the overlay's own `data-state`.
 * Render it as the overlay's only child.
 */
export function BackdropDimSource(props: {
  readonly strength: BackdropStrength;
}): ReactNode {
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const { strength } = props;
  useLayoutEffect(() => {
    const overlay = node?.parentElement;
    if (overlay === null || overlay === undefined) return undefined;
    const closing = (): boolean =>
      overlay.getAttribute("data-state") === "closed";
    const store = useBackdropDimStore.getState();
    const id = store.add(strength, closing());
    const observer = new MutationObserver(() => {
      store.setClosing(id, closing());
    });
    observer.observe(overlay, {
      attributes: true,
      attributeFilter: ["data-state"],
    });
    return () => {
      observer.disconnect();
      store.remove(id);
    };
  }, [node, strength]);
  return <span ref={setNode} hidden />;
}
