import type {
  BrowserSessionsState,
  PreparedBrowserTabOpen,
} from "../sessions/browser-sessions-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { makePendingBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";

/** Observe the canvas, not component unmount: panes can move or be retained. */
export function preparePendingBrowserTile(
  sessions: BrowserSessionsState,
  url: string,
) {
  let unsubscribe: (() => void) | null = null;
  const stopObserving = () => {
    unsubscribe?.();
    unsubscribe = null;
  };
  const request: PreparedBrowserTabOpen = sessions.prepareOpenTab(url, {
    rebind: (opened) => {
      stopObserving();
      return useEpicCanvasStore
        .getState()
        .rebindPendingBrowserTile(request.requestId, opened);
    },
    remove: () => {
      stopObserving();
      const state = useEpicCanvasStore.getState();
      for (const [viewTabId, canvas] of Object.entries(state.canvasByTabId)) {
        if (canvas === undefined) continue;
        for (const pane of collectPanes(canvas.root)) {
          for (const instanceId of pane.tabInstanceIds) {
            const ref = canvas.tilesByInstanceId[instanceId];
            if (
              ref?.type !== "browser-session" ||
              ref.pending?.requestId !== request.requestId
            )
              continue;
            state.closeCanvasTab(viewTabId, pane.id, instanceId);
          }
        }
      }
    },
  });
  const node = makePendingBrowserSessionTileRef(request);
  const observe = () => {
    const check = () => {
      const state = useEpicCanvasStore.getState();
      const present = state.openTabOrder.some((viewTabId) => {
        const ref =
          state.canvasByTabId[viewTabId]?.tilesByInstanceId[node.instanceId];
        return (
          ref?.type === "browser-session" &&
          ref.pending?.requestId === request.requestId
        );
      });
      if (!present) request.dismiss();
    };
    unsubscribe = useEpicCanvasStore.subscribe(check);
    check();
  };
  return { node, request, observe };
}
