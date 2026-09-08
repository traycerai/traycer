import { useCallback } from "react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { useEpicCreateArtifact } from "@/hooks/epic/use-epic-node-mutations";
import { openProjectedSidebarNodeInTabWhenAvailable } from "@/components/epic-canvas/sidebar/open-projected-sidebar-node";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { DEFAULT_EPIC_NODE_NAMES } from "@/lib/artifacts/node-display";
import { tileIntent } from "@/lib/canvas/tile-open/intent";

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
  const { openTile } = useEpicTileNavigation();
  const activeHostId = useEpicSessionHostId() ?? UNKNOWN_HOST_PLACEHOLDER;

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
              nodeId: result.artifactId,
              fallbackHostId: activeHostId,
              openNode: (nodeRef) => {
                openTile(
                  tileIntent(nodeRef, { tabId }, "explicit", "direct_ui"),
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
      onOpened,
      openTile,
      tabId,
    ],
  );

  return { create, isPending: createArtifact.isPending };
}
