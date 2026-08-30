import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { makeDeletedArtifactsTileRef } from "@/stores/epics/canvas/tile-schema/deleted-artifacts-tile";

/** Opens or focuses the epic's deduplicated deleted-artifacts tile. */
export function useEpicOpenDeletedArtifacts(
  epicId: string,
  hostId: string | null,
): () => void {
  const tileNavigation = useEpicTileNavigation();
  return () => {
    if (hostId === null) return;
    tileNavigation.openTileInEpic(
      epicId,
      makeDeletedArtifactsTileRef(epicId, hostId),
    );
  };
}
