import { useCallback } from "react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";

/** Opens or focuses the epic's deduplicated communication-graph tile. */
export function useOpenCommunicationGraph(epicId: string): () => void {
  const tileNavigation = useEpicTileNavigation();
  return useCallback(() => {
    tileNavigation.openTileInEpic(epicId, makeCommGraphTileRef(epicId));
  }, [epicId, tileNavigation]);
}
