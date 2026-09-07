import { useCallback } from "react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import { tileIntent } from "@/lib/canvas/tile-open/intent";

export type OpenManagedCommandOutput = (args: {
  readonly commandId: string;
  readonly hostId: string;
}) => void;

/**
 * The one door into a shell's output window, shared by every surface that opens one: a Shells row, a queued-delivery chip, a resume divider, a running-work strip row.
 */
export function useOpenManagedCommandOutput(
  epicId: string,
): OpenManagedCommandOutput {
  const { openTile } = useEpicTileNavigation();
  return useCallback(
    (args) => {
      openTile(
        tileIntent(
          makeManagedCommandOutputTileRef({
            commandId: args.commandId,
            hostId: args.hostId,
          }),
          { epicId },
          // `single` is what makes it a preview tab - see the note above.
          "single",
          "direct_ui",
        ),
      );
    },
    [epicId, openTile],
  );
}
