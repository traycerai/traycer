import { useRouter } from "@tanstack/react-router";
import { modalLayerCoversApp } from "@/components/layout/shell/shell-gestures";
import { useEdgeNavSwipe } from "@/components/layout/shell/use-edge-nav-swipe";
import { goBack, goForward } from "@/lib/commands/actions";
import { useMobileNavStore } from "@/stores/layout/mobile-nav-store";

/**
 * Binds the edge navigation swipes to the app's in-app history navigation - the
 * SAME `goBack` / `goForward` the desktop title bar's arrows and the command
 * palette call, on the current router. The phone has no room for those arrows,
 * so the gesture is the affordance; making it a second implementation of "go
 * back" would be two answers to one question, and they would drift.
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
 * Both are read at pointer-down rather than subscribed to: the listeners are
 * installed once, and the answer is only needed at the instant a finger lands.
 */
export function useMobileHistorySwipes(): void {
  const router = useRouter();
  useEdgeNavSwipe({
    onNavigate: (direction) => {
      if (direction === "back") {
        goBack(router);
        return;
      }
      goForward(router);
    },
    edgesClaimed: () =>
      useMobileNavStore.getState().open || modalLayerCoversApp(),
  });
}
