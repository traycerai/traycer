/** Opener leaf for the per-epic communication graph. */
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { openerActionLeaf } from "@/lib/commands/sources/open/open-leaf";
import { makeCommGraphTileRef } from "@/stores/epics/canvas/tile-schema/comm-graph-tile";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export function commGraphOpenerItem(ctx: CommandContext): CommandItem {
  return openerActionLeaf({
    id: "open:comm-graph",
    label: "Communication graph",
    keywords: [
      "communication",
      "graph",
      "comms",
      "agents",
      "messages",
      "a2a",
      "timeline",
    ],
    run: () => {
      const epicId = ctx.activeEpicId;
      if (epicId === null) return;
      openTileIntoTargetGroup({
        tabId: ctx.activeTabId,
        groupId: ctx.targetGroupId,
        ref: makeCommGraphTileRef(epicId),
        // Singleton: the ref's content id is the epic's, so a second view
        // would double-write the graph's persisted viewport.
        dedupe: true,
        navigateNestedFocus: ctx.router.navigateNestedFocus,
      });
    },
  });
}
