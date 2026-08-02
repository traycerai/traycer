/**
 * Ticket 21 slice 4: the component half of
 * `hosted-chat-surface-body.tsx`'s environment-to-context bridge, split into
 * its own file so that file's `renderHostedChatSurfaceBody` stays the sole
 * export (matching `tile-render.tsx`'s `renderTile` precedent) - a file
 * mixing a lowercase JSX-returning export with real components breaks
 * `react-refresh/only-export-components`.
 */
import type { ReactNode } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { renderTile } from "@/components/epic-canvas/renderers/tile-render";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import {
  PaneFocusProbeContext,
  PanePortalContainerContext,
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import type { ReadyTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { PaneActivationFocusIntentContext } from "@/components/epic-canvas/pane-activation";

export function HostedChatSurfaceContextBridge(props: {
  readonly environment: ReadyTileSurfaceEnvironment;
}): ReactNode {
  const { environment } = props;
  return (
    <EpicSessionContext.Provider value={environment.services.openEpicHandle}>
      <EpicViewTabContext.Provider value={environment.placement.viewTabId}>
        <PaneSurfaceActivityContext.Provider
          value={{
            visible: environment.presentation.topLevelVisible,
            focused: environment.presentation.topLevelFocused,
          }}
        >
          <PaneVisibilityContext.Provider
            value={environment.presentation.topLevelVisible}
          >
            <PaneActivationFocusIntentContext.Provider
              value={environment.paneActivation.focusIntent}
            >
              <PaneFocusProbeContext.Provider
                value={environment.services.isPaneFocusedNow}
              >
                <PanePortalContainerContext.Provider
                  value={environment.services.panePortalContainer}
                >
                  <TabBodySelectedContext.Provider
                    value={environment.canvasActivity.tabSelected}
                  >
                    <HostedChatSurfaceBody environment={environment} />
                  </TabBodySelectedContext.Provider>
                </PanePortalContainerContext.Provider>
              </PaneFocusProbeContext.Provider>
            </PaneActivationFocusIntentContext.Provider>
          </PaneVisibilityContext.Provider>
        </PaneSurfaceActivityContext.Provider>
      </EpicViewTabContext.Provider>
    </EpicSessionContext.Provider>
  );
}

/**
 * Header tear-off moves a tile's canvas entry to its destination top-level
 * tab in one synchronous `EpicCanvasStore` write, before the destination
 * `TileSurfaceSlot` mounts and republishes a fresh environment - `useTabsStore`'s
 * header strip catches up moments later, in the same transaction (see
 * `tile-surface-membership.ts`'s transaction-aware retention doc comment).
 * During that gap, `environment.placement.viewTabId` still names the SOURCE
 * tab, so looking the node up there returns `undefined` and unmounts the real
 * `renderTile()` subtree (finding 1). Scanning every open canvas by
 * `instanceId` instead - not just the environment's last-published tab -
 * finds the tile immediately once the canvas write lands, regardless of
 * which tab currently owns it. Placement/providers deliberately stay on the
 * last-ready environment until the destination publish replaces them; only
 * the node CONTENT needs to survive the gap.
 */
function useCurrentCanvasTile(
  instanceId: string,
): EpicCanvasTileRef | undefined {
  return useEpicCanvasStore((s) => {
    for (const canvas of Object.values(s.canvasByTabId)) {
      const tile = canvas?.tilesByInstanceId[instanceId];
      if (tile !== undefined) return tile;
    }
    return undefined;
  });
}

function HostedChatSurfaceBody(props: {
  readonly environment: ReadyTileSurfaceEnvironment;
}): ReactNode {
  const { environment } = props;
  const node = useCurrentCanvasTile(environment.identity.instanceId);
  const role = useEpicPermissionRole();
  if (node === undefined) return null;
  // Same rule as `ActiveTabBody`'s inline `isActive` - never a second
  // independent active boolean.
  const isActive =
    role !== null &&
    environment.canvasActivity.tabSelected &&
    environment.canvasActivity.canvasPaneActive;
  return renderTile({
    node,
    viewTabId: environment.placement.viewTabId,
    tileId: environment.placement.paneId,
    epicId: environment.placement.epicId,
    isActive,
  });
}
