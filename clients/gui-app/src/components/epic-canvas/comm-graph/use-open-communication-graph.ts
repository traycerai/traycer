import { useCallback } from "react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import { tileIntent } from "@/lib/canvas/tile-open/intent";

/** Opens or focuses the epic's deduplicated communication-graph tile. */
export function useOpenCommunicationGraph(epicId: string): () => void {
  const { openTile } = useEpicTileNavigation();
  return useCallback(() => {
    openTile(
      tileIntent(
        makeCommGraphTileRef(epicId),
        { epicId },
        "explicit",
        "direct_ui",
      ),
    );
  }, [epicId, openTile]);
}
