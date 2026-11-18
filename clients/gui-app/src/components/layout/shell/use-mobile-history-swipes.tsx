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

/**
 * Binds the edge navigation swipes to the app's in-app history navigation - the
 * SAME `goBack` / `goForward` the desktop title bar's arrows and the command
 * palette call, on the current router. The phone has no room for those arrows,
 * so the gesture is the affordance; making it a second implementation of "go
 * back" would be two answers to one question, and they would drift.
 *
 * Returns the transition's layers for the shell to render. They are returned
 * rather than portalled because WHERE they sit is part of what they are: a
 * frozen screen has to be laid over the surface it was copied from, inside the
 * same box, or it is a screen-sized rectangle floating over the app rather than
 * the app's own screen leaving.
 *
 * Typed as an ELEMENT rather than as a `ReactNode`, which is the wider type a
 * component would return. `ReactNode` admits a promise, so a caller that only
 * wants the hook's side effects - every test that mounts the recognizer without
 * rendering a transition - would be calling something that looks like a
 * discarded async result. The narrower type says what this actually produces.
 *
 * Two things put the edges out of reach, and both are the same statement: the
 * surface underneath is not the user's to act on right now.
 *
 * The drawer claims both edges while it is out - its panel covers the leading
 * one and its scrim the rest, and both are already inside a drag of their own.
 * A modal layer covers everything by definition; navigating the surface beneath
 * a dialog would take the user somewhere they cannot see while the dialog is
 * still on top of it, which reads as the app losing their place AND eating the
 * dialog in one gesture. Standing down is the whole fix - dismissing the modal
 * on a back swipe, the way the platform does, is a gesture of its own with its
 * own follow-the-finger tracking and is deliberately not attempted here.
 *
 * Both are read imperatively rather than subscribed to: the listeners are
 * installed once, and the recognizer asks at pointer-down and again on every
 * move the gesture has not yet activated on. Past activation the drag is
 * locked and neither claim is consulted again.
 */
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
