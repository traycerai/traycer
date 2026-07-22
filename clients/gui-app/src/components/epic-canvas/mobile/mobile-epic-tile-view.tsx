import { useMemo } from "react";
import { ActiveTabBody } from "@/components/epic-canvas/canvas/tab-group-view";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { useEpicCanvas, useIsActivePane } from "@/stores/epics/canvas/store";

interface MobileEpicTileViewProps {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Phone (<768px) epic view: renders exactly ONE canvas tile full-screen in
 * place of the desktop split canvas. Mounted only from the `useIsMobile()`
 * branch in `TileCanvasLive` (non-null root), so the desktop tiling layer is
 * never built here. The tile is chosen by {@link selectMobileTile}, which reads
 * but never writes the split tree.
 *
 * The selected tile renders through the shared `ActiveTabBody` (identical
 * remote-deleted guard + `isActive` derivation as the desktop tab group),
 * wrapped in `TabBodySelectedContext value` because it is the one shown
 * surface. Pane visibility still comes from `EpicTabHost`, so a hidden
 * keep-alive epic pane stays non-visible.
 *
 * v1 keep-alive tradeoff (user-approved): only the current tile mounts, so
 * switching tiles remounts the body - chat scroll position and terminal
 * scrollback reset, though the host PTY session itself survives. A later
 * iteration can mount hidden sibling layers like `TabGroupView` if per-tile
 * view state must persist across switches.
 */
export function MobileEpicTileView(props: MobileEpicTileViewProps) {
  const { epicId, tabId } = props;
  const canvas = useEpicCanvas(tabId);
  const selection = useMemo(() => selectMobileTile(canvas), [canvas]);
  // Match the desktop `globallyActive` signal for this tile so `isActive`
  // (focused-composer registration) is computed identically; `""` is a
  // no-match sentinel that resolves to `false` while there is no selection.
  const globallyActive = useIsActivePane(tabId, selection?.paneId ?? "");

  if (selection === null) return null;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-canvas"
      data-testid="mobile-epic-tile-view"
    >
      <div className="relative min-h-0 flex-1">
        <TabBodySelectedContext.Provider value>
          <ActiveTabBody
            activeTab={selection.ref}
            epicId={epicId}
            groupId={selection.paneId}
            tabId={tabId}
            selected
            globallyActive={globallyActive}
          />
        </TabBodySelectedContext.Provider>
      </div>
    </div>
  );
}
