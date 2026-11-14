import { useCallback, useEffect, useRef, type ReactElement } from "react";
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
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { useTabsStore } from "@/stores/tabs/store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";
import { isMobileApp } from "@/lib/mobile-app";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

/**
 * Route edge swipes to panels or to the shared history actions. Transition
 * layers stay in the shell so their frozen screens overlay the live surface.
 * The drawer and blocking layers claim the edges while the content is covered.
 */
export function useMobileHistorySwipes(): ReactElement | null {
  const router = useRouter();
  // Capture before a pointer on the other split pane can change engagement.
  const swipeTarget = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!isMobileApp()) return;
    const captureTarget = () => {
      const focused = selectHostFocusedRef(useTabsStore.getState());
      swipeTarget.current =
        focused?.kind === "epic"
          ? useMobileSwitcherStore.getState().swipeOpenByTabId[focused.id]
          : undefined;
    };
    document.addEventListener("pointerdown", captureTarget, true);
    return () =>
      document.removeEventListener("pointerdown", captureTarget, true);
  }, []);
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
  // The same eligibility scan the navigation itself runs, asked ahead of it:
  // the screen shown travelling under the finger must be the screen the
  // committed step lands on, and only the action layer knows which one that
  // is. The transition receives the entry's stable KEY - the identity frozen
  // screens are filed under - not its index, which re-stamping can move.
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
    onDragStart: (direction) => {
      if (useSettingsStore.getState().mobileSwipeHistory)
        return transition.beginDrag(direction);
      if (direction === "back") return "instant";
      return swipeTarget.current === undefined ? "decline" : "instant";
    },
    onDragMove: transition.updateDrag,
    onDragEnd: transition.endDrag,
    onNavigate: (direction) => {
      if (useSettingsStore.getState().mobileSwipeHistory) {
        navigate(direction);
      } else if (direction === "back") {
        useMobileNavStore.getState().setOpen(true);
      } else {
        swipeTarget.current?.();
      }
    },
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
