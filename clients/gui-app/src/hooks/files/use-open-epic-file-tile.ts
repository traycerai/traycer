import { useCallback } from "react";
import type { EpicFileRef } from "@traycer/protocol/persistence/epic/files";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";

/** One file version, and what its tab is titled. */
export interface EpicFileOpenTarget extends EpicFileRef {
  readonly name: string;
}

/**
 * Opens one epic file in the epic-file tile, bound to `hostId` for life.
 * `name` titles the tab: the file's label (`epicFileLabel`), not its path.
 *
 * `via` is `null`: a file opened from the Files panel or the version menu is
 * not opened from a transcript row, so the host decides a page's network policy
 * without one (§2.3) - the same answer the "Updated from" caption gets.
 */
export function useOpenEpicFileTile(
  epicId: string,
  hostId: string,
): (file: EpicFileOpenTarget) => void {
  const { openTile } = useEpicTileNavigation();
  return useCallback(
    (file: EpicFileOpenTarget): void => {
      openTile(
        tileIntent(
          makeEpicFileTileRef({
            path: file.path,
            sha256: file.sha256,
            name: file.name,
            hostId,
            via: null,
          }),
          { epicId },
          "explicit",
          "direct_ui",
        ),
      );
    },
    [openTile, epicId, hostId],
  );
}
