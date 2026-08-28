import { useCallback } from "react";
import { toast } from "sonner";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  DEFAULT_BROWSER_TILE_URL,
  makeBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/** Opens a fresh browser tab on the panel's host and focuses it in the tab. */
export function useAddBrowserAction(epicId: string, tabId: string): () => void {
  const sessions = useBrowserSessionsContext();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpen = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  return useCallback(() => {
    if (sessions.lifecycle !== "live" || sessions.hostId === null) {
      toast.error("Browsers are not connected yet.");
      return;
    }
    const hostId = sessions.hostId;
    void sessions
      .openTab(null, DEFAULT_BROWSER_TILE_URL)
      .then((opened) => {
        navigateNested(epicId, tabId, () =>
          prepareOpen(
            tabId,
            makeBrowserSessionTileRef({
              hostId,
              sessionId: opened.sessionId,
              tabId: opened.tabId,
            }),
          ),
        );
      })
      .catch((cause: unknown) => {
        toast.error(
          cause instanceof Error ? cause.message : "Couldn't open a browser.",
        );
      });
  }, [epicId, navigateNested, prepareOpen, sessions, tabId]);
}
