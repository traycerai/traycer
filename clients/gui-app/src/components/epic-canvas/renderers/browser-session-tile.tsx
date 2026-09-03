import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { BrowserTabTile } from "@/components/browser-tile/browser-tab-tile";
import type {
  BrowserTileNode,
  BrowserTilePlacement,
} from "@/components/browser-tile/browser-tile-placement";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import { useMaybeBrowserSessionsContext } from "./browser-sessions-context";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import type { TileOpenTarget } from "@/lib/canvas/tile-open/intent";
import { convertBrowserTabToPip } from "@/lib/browser-view/pip/pip-store";
import type { BrowserViewViewportPresetId } from "@traycer-clients/shared/platform/browser-view";
import { browserSessionsRefusal } from "@traycer-clients/shared/platform/browser-view";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import type { BrowserSessionTileRef } from "@/stores/epics/canvas/types";

interface BrowserSessionTileProps {
  readonly node: BrowserSessionTileRef;
  readonly viewTabId: string;
  readonly paneId: string;
  readonly epicId: string;
}

/** The canvas node id IS the Electron tile key's pageSessionId, never the host sessionId. */
function pageSessionIdForCanvasTile(nodeId: string): string {
  return nodeId;
}

/**
 * The canvas adapter for the shared browser tab tile.
 *
 * Everything below is a canvas fact translated into a prop: the tile body and
 * its surfaces read no canvas context of their own, which is what lets the
 * Start Page render the same body. The body owns the behavior; this file owns
 * only the translation.
 *
 * The annotation session is the one canvas-shaped thing that stays in the
 * native surface rather than moving here, because it is keyed to that
 * surface's own live status and tile key - state that does not exist outside
 * it. It takes the epic from the placement and goes inert where there is
 * none, so the boundary holds: nothing under `components/browser-tile/`
 * imports the canvas store.
 */
export function BrowserSessionTile(props: BrowserSessionTileProps) {
  const visible = useTileBodyVisible();
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.paneId,
    props.node.instanceId,
  );
  const browserSessions = useMaybeBrowserSessionsContext();
  const { openTile } = useEpicTileNavigation();
  const persistViewportPresetInTab = useEpicCanvasStore(
    (state) => state.updateBrowserTileViewportPresetInTab,
  );

  // `placement` and `node` must keep a stable identity across renders: the
  // native surface memoizes its tile key and binding id on them, and the tile
  // key is what its surface-attach effect is keyed to. A fresh object every
  // render would detach and re-attach the native view on every render.
  const placement = useMemo<BrowserTilePlacement>(
    () => ({
      kind: "canvas",
      epicId: props.epicId,
      viewTabId: props.viewTabId,
      paneId: props.paneId,
    }),
    [props.epicId, props.viewTabId, props.paneId],
  );
  const node = useMemo<BrowserTileNode>(
    () => ({
      instanceId: props.node.instanceId,
      hostId: props.node.hostId,
      sessionId: props.node.sessionId,
      tabId: props.node.tabId,
      viewportPreset: props.node.viewportPreset,
    }),
    [
      props.node.instanceId,
      props.node.hostId,
      props.node.sessionId,
      props.node.tabId,
      props.node.viewportPreset,
    ],
  );

  const persistViewportPreset = useCallback(
    (preset: BrowserViewViewportPresetId) => {
      persistViewportPresetInTab(
        props.viewTabId,
        props.node.instanceId,
        preset,
      );
    },
    [persistViewportPresetInTab, props.viewTabId, props.node.instanceId],
  );

  /** Open a tab in this tile's session and place it beside this tile. */
  const onOpenLinkInNewTile = useCallback(
    (url: string, disposition: "foreground" | "background") => {
      if (
        browserSessions === null ||
        browserSessions.lifecycle !== "live" ||
        browserSessions.hostId !== props.node.hostId
      ) {
        toast.error(browserSessionsRefusal(browserSessions));
        return;
      }
      void browserSessions
        .openTab(props.node.sessionId, url)
        .then((opened) => {
          // Browser semantics, never the placement setting (A4): the popup is
          // a tab of THIS pane's session, and a background disposition
          // (middle/ctrl/cmd-click) leaves the current tab active.
          openTile({
            node: makeBrowserSessionTileRef({
              hostId: props.node.hostId,
              sessionId: opened.sessionId,
              tabId: opened.tabId,
            }),
            // Resolved after the await, not before: the view tab can close
            // while `openTab` is in flight, and opening into a closed tab id
            // mutates a canvas with no route (R8).
            target: currentPopupTarget(props.viewTabId, props.epicId),
            gesture: disposition === "background" ? "host" : "explicit",
            modifiers: null,
            placement: { kind: "tab", paneId: props.paneId, index: null },
            dedupe: true,
            source: "direct_ui",
          });
        })
        .catch((cause: unknown) => {
          toast.error(
            cause instanceof Error
              ? cause.message
              : "Couldn't open the browser tab.",
          );
        });
    },
    [
      browserSessions,
      openTile,
      props.epicId,
      props.node.hostId,
      props.node.sessionId,
      props.paneId,
      props.viewTabId,
    ],
  );

  const onConvertToPip = useCallback(() => {
    convertBrowserTabToPip({
      epicId: props.epicId,
      hostId: props.node.hostId,
      sessionId: props.node.sessionId,
      tabId: props.node.tabId,
      origin: "manual",
      onReady: closeCanvasTile,
      onError: (message) => toast.error(message),
    });
  }, [
    closeCanvasTile,
    props.epicId,
    props.node.hostId,
    props.node.sessionId,
    props.node.tabId,
  ]);

  return (
    <BrowserTabTile
      placement={placement}
      node={node}
      visible={visible}
      pageSessionId={pageSessionIdForCanvasTile(props.node.id)}
      onRequestClose={closeCanvasTile}
      persistViewportPreset={persistViewportPreset}
      onOpenLinkInNewTile={onOpenLinkInNewTile}
      // The canvas has no answer of its own to "new tab" beyond opening one
      // beside this tile, which is what the link path already does.
      onRequestNewTab={null}
      onConvertToPip={onConvertToPip}
    />
  );
}

/**
 * The popup's own canvas tab while it still exists, else the epic - which
 * lets the resolver pick (or create) a live tab instead of writing a tile
 * into a tab that closed while `openTab` was in flight (R8).
 */
function currentPopupTarget(viewTabId: string, epicId: string): TileOpenTarget {
  const tabs = useEpicCanvasStore.getState().tabsById;
  if (tabs[viewTabId] !== undefined) return { tabId: viewTabId };
  return { epicId };
}
