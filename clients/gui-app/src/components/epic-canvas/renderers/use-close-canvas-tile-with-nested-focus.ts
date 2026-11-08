import { useCallback } from "react";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import type { NestedFocusProvenance } from "@/lib/epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * Closes the tile, taking who asked at the moment of the CALL.
 *
 * Deliberately not baked in when the callback is built. One closure here is
 * routinely wired to several actors at once: `terminal-tile`'s single
 * `closeExitedTile` serves the pre-attach exit effect, the attached terminal's
 * own exit, the setup-unavailable Close button, and the sign-in restart
 * panel - two automatic, two a person. A closure-level answer would have to be
 * wrong for some of them, and the wrong answer is silent: a shell exiting on
 * its own, read as the person turning away, discards an artifact request the
 * route is still waiting on. So the actor is a property of the invocation, and
 * every call states it.
 *
 * A call site that hands this to an `onClose`-style prop therefore wraps it -
 * `onClose={() => close("user")}` - rather than passing it bare, so the prop's
 * consumer cannot decide the question for it.
 */
export function useCloseCanvasTileWithNestedFocus(
  viewTabId: string,
  paneId: string,
  tileInstanceId: string,
): (provenance: NestedFocusProvenance) => void {
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareCloseCanvasTabFocusTarget,
  );

  return useCallback(
    (provenance: NestedFocusProvenance) => {
      const epicId =
        useEpicCanvasStore.getState().tabsById[viewTabId]?.epicId ?? null;
      const prepare = () =>
        prepareCloseCanvasTabFocusTarget(viewTabId, paneId, tileInstanceId);
      if (epicId === null) {
        // No epic to commit a route for, and so no tab a pending request could
        // be landing in: the canvas mutation runs on its own, claiming nothing
        // either way.
        prepare();
        return;
      }
      navigateNested(epicId, viewTabId, prepare, provenance);
    },
    [
      navigateNested,
      paneId,
      prepareCloseCanvasTabFocusTarget,
      tileInstanceId,
      viewTabId,
    ],
  );
}
