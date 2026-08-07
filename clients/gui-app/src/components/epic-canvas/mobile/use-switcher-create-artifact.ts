import { useCallback } from "react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { useEpicCreateArtifact } from "@/hooks/epic/use-epic-node-mutations";
import { openProjectedSidebarNodeInTabWhenAvailable } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { DEFAULT_EPIC_NODE_NAMES } from "@/lib/artifacts/node-display";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

export interface SwitcherCreateArtifact {
  readonly create: (type: EpicArtifactKind) => void;
  readonly isPending: boolean;
}

/**
 * One-shot artifact creation from the switcher, reusing the exact desktop
 * `addRoot` functions: `useEpicCreateArtifact` then the shared
 * `openProjectedSidebarNodeInTabWhenAvailable` seam, which opens the artifact
 * once it projects. That open lands it as the visible mobile tile, which trips
 * the sheet's active-tile watcher to close. The desktop's inline
 * pending-create staging (a left-panel-only UI) is intentionally omitted; the
 * create + open functions are identical.
 */
export function useSwitcherCreateArtifact(
  epicId: string,
  tabId: string,
  onOpened: () => void,
): SwitcherCreateArtifact {
  const createArtifact = useEpicCreateArtifact();
  const epicHandle = useOpenEpicHandle();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const activeHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;

  const create = useCallback(
    (type: EpicArtifactKind) => {
      createArtifact.mutate(
        {
          epicId,
          parentId: null,
          artifactType: type,
          title: DEFAULT_EPIC_NODE_NAMES[type],
        },
        {
          onSuccess: (result) => {
            openProjectedSidebarNodeInTabWhenAvailable({
              epicHandle,
              tabId,
              nodeId: result.artifactId,
              fallbackHostId: activeHostId,
              openTileInTab: (targetTabId, nodeRef: EpicNodeRef) => {
                navigateNested(epicId, targetTabId, () =>
                  prepareOpenTileInTabFocusTarget(targetTabId, nodeRef),
                );
              },
              onBeforeOpen: null,
              // The artifact tile is not embed-originated, so the sheet's
              // watcher won't close on it; close here when it actually opens so
              // the new artifact lands as the visible tile.
              onOpened,
              onUnavailable: () => undefined,
              onCleanup: null,
            });
          },
        },
      );
    },
    [
      activeHostId,
      createArtifact,
      epicHandle,
      epicId,
      navigateNested,
      onOpened,
      prepareOpenTileInTabFocusTarget,
      tabId,
    ],
  );

  return { create, isPending: createArtifact.isPending };
}
