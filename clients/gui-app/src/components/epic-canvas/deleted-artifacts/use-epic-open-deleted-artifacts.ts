import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { makeDeletedArtifactsTileRef } from "@/stores/epics/canvas/tile-schema/deleted-artifacts-tile";

/** Opens or focuses the epic's deduplicated deleted-artifacts tile. */
export function useEpicOpenDeletedArtifacts(
  epicId: string,
  hostId: string | null,
): () => void {
  const tileNavigation = useEpicTileNavigation();
  return () => {
    if (hostId === null) return;
    // A deliberate open (button / menu item), so `explicit`: permanent, and
    // deduped onto the epic's one recovery tile by the intent's default.
    tileNavigation.openTile(
      tileIntent(
        makeDeletedArtifactsTileRef(epicId, hostId),
        { epicId },
        "explicit",
        "direct_ui",
      ),
    );
  };
}
