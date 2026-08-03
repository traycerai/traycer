import { useCallback } from "react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";

export type OpenManagedCommandOutput = (args: {
  readonly commandId: string;
  readonly hostId: string;
}) => void;

/**
 * The one door into a command's output window, shared by every surface that
 * opens one: a "Monitors & Shells" row, a queued-delivery chip, a resume
 * divider, a running-work strip row.
 *
 * One window per command (`UI.md` §9) falls out of the canvas itself: the
 * tile's content id IS the command id, and `openTileInEpic` focuses an already
 * open tab for the same content instead of opening a second one.
 */
export function useOpenManagedCommandOutput(
  epicId: string,
): OpenManagedCommandOutput {
  const { openTileInEpic } = useEpicTileNavigation();
  return useCallback(
    (args) => {
      openTileInEpic(
        epicId,
        makeManagedCommandOutputTileRef({
          commandId: args.commandId,
          hostId: args.hostId,
        }),
      );
    },
    [epicId, openTileInEpic],
  );
}
