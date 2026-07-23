import { useCallback } from "react";
import { useMobileEpicTiles } from "@/components/epic-canvas/mobile/use-mobile-epic-tiles";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { findOpenArtifactInTab } from "@/stores/epics/canvas/canvas-selectors";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

export type SwitcherActivate = (
  contentId: string,
  buildRef: () => EpicNodeRef,
) => void;

/**
 * Shared row-tap handler for the switcher's flat lists. If the item is already
 * an open tile in this tab, activate it via the existing desktop tab-selection
 * path (`useMobileEpicTiles().selectTile`); otherwise open it permanently
 * (`openTileInTab`) through `navigateNested` + the lint-blessed
 * `prepareOpenTileInTabFocusTarget` (raw canvas actions are ESLint-banned).
 * Either way the sheet closes, so the chosen tile becomes the full-screen
 * mobile tile.
 */
export function useSwitcherActivate(
  epicId: string,
  tabId: string,
  onClose: () => void,
): SwitcherActivate {
  const { selectTile } = useMobileEpicTiles(tabId);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  return useCallback(
    (contentId, buildRef) => {
      const found = findOpenArtifactInTab(tabId, contentId);
      if (found !== null) {
        selectTile(found.paneId, found.instanceId);
      } else {
        navigateNested(epicId, tabId, () =>
          prepareOpenTileInTabFocusTarget(tabId, buildRef()),
        );
      }
      onClose();
    },
    [
      epicId,
      navigateNested,
      onClose,
      prepareOpenTileInTabFocusTarget,
      selectTile,
      tabId,
    ],
  );
}
