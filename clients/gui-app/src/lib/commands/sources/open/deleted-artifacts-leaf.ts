/**
 * Opener leaf for an epic's host-bound deleted-artifact recovery surface.
 *
 * This is a direct leaf rather than a category: there is one recovery surface
 * per epic/host pair, so a sub-page containing one row would add a wasted step.
 * The caller capability-gates the leaf because deleted-artifact RPCs are an
 * optional host feature.
 *
 * Routed through the singleton opener delegate so selecting the row again
 * focuses the existing recovery tile instead of opening a duplicate.
 */
import { openSingletonTileIntoTargetGroup } from "@/lib/commands/actions";
import { openerActionLeaf } from "@/lib/commands/sources/open/open-leaf";
import { makeDeletedArtifactsTileRef } from "@/stores/epics/canvas/tile-schema/deleted-artifacts-tile";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export function deletedArtifactsOpenerItem(
  ctx: CommandContext,
  hostId: string,
): CommandItem {
  return openerActionLeaf({
    id: "open:deleted-artifacts",
    label: "Deleted artifacts",
    keywords: [
      "deleted",
      "artifacts",
      "trash",
      "restore",
      "recovery",
      "recover",
    ],
    run: () => {
      const epicId = ctx.activeEpicId;
      if (epicId === null) return;
      openSingletonTileIntoTargetGroup({
        tabId: ctx.activeTabId,
        groupId: ctx.targetGroupId,
        ref: makeDeletedArtifactsTileRef(epicId, hostId),
        navigateNestedFocus: ctx.router.navigateNestedFocus,
      });
    },
  });
}
