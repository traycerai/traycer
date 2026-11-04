/** Restores the contexts lost when a chat moves into the stable surface host. */
import type { ReactNode } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { renderTile } from "@/components/epic-canvas/renderers/tile-render";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
  getEpicSessionHandleHostId,
} from "@/lib/registries/epic-session-registry";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import {
  BrowserOpenSessionsProvider,
  BrowserSessionsHostProvider,
} from "@/components/epic-canvas/renderers/browser-sessions-provider";
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
import { MobileTileOpenTargetContext } from "@/lib/canvas/tile-open/mobile-tile-open-target-context";

export function HostedChatSurfaceContextBridge(props: {
  readonly environment: ReadyTileSurfaceEnvironment;
}): ReactNode {
  const { environment } = props;
  const hostId = getEpicSessionHandleHostId(
    environment.services.openEpicHandle,
  );
  return (
    <EpicSessionContext.Provider value={environment.services.openEpicHandle}>
      {/* The session's reads (task hosts, collaborators) key on its host; a
          hosted tile without this client keys them on none and never asks. */}
      <EpicSessionHostClientContext.Provider
        value={environment.services.hostClient}
      >
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
              <BrowserSessionsHostProvider
                hostId={hostId}
                hostClient={environment.services.hostClient}
                scope={{ kind: "epic", epicId: environment.placement.epicId }}
              >
                <BrowserOpenSessionsProvider
                  epicId={environment.placement.epicId}
                  tabId={environment.placement.viewTabId}
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
                          <MobileTileOpenTargetContext
                            value={environment.services.mobileOpenTarget}
                          >
                            <HostedChatSurfaceBody environment={environment} />
                          </MobileTileOpenTargetContext>
                        </TabBodySelectedContext.Provider>
                      </PanePortalContainerContext.Provider>
                    </PaneFocusProbeContext.Provider>
                  </PaneActivationFocusIntentContext.Provider>
                </BrowserOpenSessionsProvider>
              </BrowserSessionsHostProvider>
            </PaneVisibilityContext.Provider>
          </PaneSurfaceActivityContext.Provider>
        </EpicViewTabContext.Provider>
      </EpicSessionHostClientContext.Provider>
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
 * `renderTile()` subtree. Scanning every open canvas by
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
