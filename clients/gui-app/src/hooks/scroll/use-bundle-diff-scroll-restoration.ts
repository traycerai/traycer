import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type { StateSnapshot, VirtuosoHandle } from "react-virtuoso";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import type { ScrollRestorationAdapter } from "@/hooks/scroll/scroll-restoration-adapter";
import { useScrollRestoration } from "@/hooks/scroll/use-scroll-restoration";
import { useTileScrollAnchorStore } from "@/stores/epics/canvas/tile-scroll-anchor-store";

interface BundleDiffScrollRestoration {
  readonly virtuosoRef: RefObject<VirtuosoHandle | null>;
  readonly restoreStateFrom: StateSnapshot | undefined;
  readonly isScrolling: (scrolling: boolean) => void;
}

/**
 * Scroll preservation for a `react-virtuoso` bundle (multi-file) diff list.
 * Spread `ref`, `restoreStateFrom`, and `isScrolling` onto the `<Virtuoso>`.
 *
 * Two mechanisms cooperate because virtualization makes a raw pixel scroll
 * unreliable on a fresh list:
 * - `restoreStateFrom` seeds the initial mount from the saved snapshot (item
 *   ranges + scrollTop), so a full remount after eviction lands correctly even
 *   before every row is measured.
 * - the imperative `scrollTo` (via `applyAnchor`) handles the keep-alive
 *   hidden -> visible case, where the list stayed mounted and measured but
 *   `display:none` zeroed its scrollTop.
 *
 * Virtuoso has no continuous state callback, so we snapshot via `getState` each
 * time scrolling settles (`isScrolling(false)`) while the scroller is still
 * visible - a `getState` at hide time would read the already-zeroed scrollTop.
 */
export function useBundleDiffScrollRestoration(
  instanceId: string,
  contentReady: boolean,
): BundleDiffScrollRestoration {
  const visible = useTileBodyVisible();
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const lastStateRef = useRef<StateSnapshot | null>(null);

  // Seed the initial mount from any anchor saved before a prior unmount.
  const [restoreStateFrom] = useState<StateSnapshot | undefined>(() => {
    const anchor = useTileScrollAnchorStore.getState().getAnchor(instanceId);
    return anchor !== undefined && anchor.kind === "bundle-diff"
      ? anchor.virtuosoState
      : undefined;
  });

  const isScrolling = useCallback((scrolling: boolean): void => {
    if (scrolling) return;
    virtuosoRef.current?.getState((state) => {
      lastStateRef.current = state;
    });
  }, []);

  const adapter = useMemo<ScrollRestorationAdapter>(
    () => ({
      captureAnchor: () => {
        const state = lastStateRef.current;
        if (state === null) return null;
        return { kind: "bundle-diff", virtuosoState: state };
      },
      applyAnchor: (anchor) => {
        if (anchor.kind !== "bundle-diff") return "gave-up";
        const handle = virtuosoRef.current;
        if (handle === null) return "retry";
        handle.scrollTo({ top: anchor.virtuosoState.scrollTop });
        return "applied";
      },
    }),
    [],
  );

  useScrollRestoration(instanceId, adapter, visible, contentReady);

  return { virtuosoRef, restoreStateFrom, isScrolling };
}
