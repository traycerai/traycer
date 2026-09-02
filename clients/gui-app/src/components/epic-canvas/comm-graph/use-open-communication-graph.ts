import { useCallback } from "react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";

/** Opens or focuses the epic's deduplicated communication-graph tile. */
export function useOpenCommunicationGraph(epicId: string): () => void {
  const { openTile } = useEpicTileNavigation();
  return useCallback(() => {
    openTile({
      node: makeCommGraphTileRef(epicId),
      target: { epicId },
      gesture: "explicit",
      modifiers: null,
      placement: null,
      dedupe: true,
      source: "direct_ui",
    });
  }, [epicId, openTile]);
}
