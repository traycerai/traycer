import { useCallback, type ReactElement } from "react";
import { useRouter } from "@tanstack/react-router";
import { modalLayerCoversApp } from "@/components/layout/shell/shell-gestures";
import { SwipeNavTransitionLayers } from "@/components/layout/shell/swipe-nav-transition-layers";
import { useEdgeNavSwipe } from "@/components/layout/shell/use-edge-nav-swipe";
import type { EdgeNavDirection } from "@/components/layout/shell/use-edge-nav-swipe";
import { useSwipeNavTransition } from "@/components/layout/shell/use-swipe-nav-transition";
import {
  goBack,
  goForward,
  resolveEligibleHistoryTarget,
} from "@/lib/commands/actions";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

/** Typed as an element rather than as a `ReactNode`, which is the wider type a component would return. */
export function useMobileHistorySwipes(): ReactElement | null {
  const router = useRouter();
  const navigate = useCallback(
    (direction: EdgeNavDirection): void => {
      if (direction === "back") {
        goBack(router);
        return;
      }
      goForward(router);
    },
    [router],
  );
  const resolveDestination = useCallback(
    (direction: EdgeNavDirection): string | null =>
      resolveEligibleHistoryTarget(router, direction === "back" ? -1 : 1)
        ?.key ?? null,
    [router],
  );
  const transition = useSwipeNavTransition(
    router,
    navigate,
    resolveDestination,
  );
  useEdgeNavSwipe({
    onDragStart: transition.beginDrag,
    onDragMove: transition.updateDrag,
    onDragEnd: transition.endDrag,
    onNavigate: navigate,
    edgesClaimed: () =>
      useMobileNavStore.getState().open || modalLayerCoversApp(),
  });
  if (transition.view === null) return null;
  return (
    <SwipeNavTransitionLayers
      progress={transition.progress}
      view={transition.view}
    />
  );
}
