/**
 * Opener leaf for the per-epic communication graph.
 *
 * A plain leaf rather than a category with a sub-page: the graph is
 * epic-scoped and singular, and it needs no host pick because the tile itself
 * subscribes to every host the epic's agents live on.
 *
 * Routed through the SINGLETON opener delegate, not the default one: the tile
 * id is computed from the epic, so the ordinary "fresh non-deduped instance"
 * opener would mint a second tab sharing that content id - and therefore
 * sharing the persisted viewport, so panning one graph would move the other.
 * Invoking this twice focuses the open graph instead.
 */
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
