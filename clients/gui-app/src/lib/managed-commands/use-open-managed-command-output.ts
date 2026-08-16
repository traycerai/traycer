import { useCallback } from "react";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";

export type OpenManagedCommandOutput = (args: {
  readonly commandId: string;
  readonly hostId: string;
}) => void;

/**
 * The one door into a shell's output window, shared by every surface that
 * opens one: a Shells row, a queued-delivery chip, a resume divider, a
 * running-work strip row.
 *
 * One window per command (`UI.md` §9) falls out of the canvas itself: the
 * tile's content id IS the command id, and the epic-level open focuses an
 * already open tab for the same content instead of opening a second one.
 *
 * Opened as a PREVIEW tab. Every door here is a glance - "what is that shell
 * printing?" - taken from a row or a chip the reader is passing through, and a
 * permanent tab per glance silts up the strip with logs nobody asked to keep.
 * The standard promotion rules make the keeper: double-click the tab, re-open
 * it deliberately, or start dragging it.
 */
export function useOpenManagedCommandOutput(
  epicId: string,
): OpenManagedCommandOutput {
  const { openTilePreviewInEpic } = useEpicTileNavigation();
  return useCallback(
    (args) => {
      openTilePreviewInEpic(
        epicId,
        makeManagedCommandOutputTileRef({
          commandId: args.commandId,
          hostId: args.hostId,
        }),
      );
    },
    [epicId, openTilePreviewInEpic],
  );
}
