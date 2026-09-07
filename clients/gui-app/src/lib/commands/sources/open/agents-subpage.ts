/** Opener **Agents** sub-page - the single Agent category in the pane opener. */
import { agentActivityTiers } from "@/lib/agent-activity";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { useChatsOpenerItems } from "@/lib/commands/sources/open/chats-subpage";
import { useTuiOpenerItems } from "@/lib/commands/sources/open/tui-subpage";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import { projectTreeSlice } from "@/stores/epics/open-epic/projection-helpers";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

/**
 * One interface's contribution to the Agents sub-page.
 * `create` is kept out of `existing` so the merged page can group creation entries at the top rather than interleaving them between the two interfaces' records.
 */
export interface OpenerInterfaceItems {
  readonly create: CommandItem;
  readonly existing: ReadonlyArray<CommandItem>;
}

export function useAgentsOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const chat = useChatsOpenerItems(ctx);
  const terminal = useTuiOpenerItems(ctx);
  const projection = useActiveEpicProjection(ctx.activeEpicId);
  const activity = agentActivityTiers(useEpicAgentActivity(ctx.activeEpicId));
  if (projection === null) return [chat.create, terminal.create];
  // The command palette subscribes to the passive registry projection outside EpicSessionProvider.
  // Its independently cached `tree` index can briefly be empty while the record slices are already populated (the sidebar, inside the provider, does not have that gap).
  const tree = projectTreeSlice(
    projection.artifacts,
    projection.chats,
    projection.tuiAgents,
  );
  const itemByNodeId = new Map<string, CommandItem>();
  for (const item of [...chat.existing, ...terminal.existing]) {
    const prefix = item.id.startsWith("open:chats:")
      ? "open:chats:"
      : "open:tui:";
    const nodeId = item.id.slice(prefix.length);
    itemByNodeId.set(nodeId, item);
  }
  const existing: CommandItem[] = [];
  const append = (nodeId: string, ancestorIds: ReadonlyArray<string>): void => {
    const node = tree.nodeById[nodeId];
    const item = itemByNodeId.get(nodeId);
    const childIds = Object.hasOwn(tree.childrenByParent, nodeId)
      ? tree.childrenByParent[nodeId]
      : [];
    if (
      item !== undefined &&
      (node.type === "chat" || node.type === "terminal-agent")
    ) {
      existing.push({
        ...item,
        agentTreeRow: {
          nodeId,
          depth: ancestorIds.length,
          ancestorIds,
          hasChildren: childIds.length > 0,
          interface: node.type === "chat" ? "chat" : "terminal",
          activity: activity.get(nodeId) ?? "idle",
        },
      });
    }
    for (const childId of childIds) {
      append(childId, [...ancestorIds, nodeId]);
    }
  };
  for (const rootId of tree.rootIds) append(rootId, []);
  return [chat.create, terminal.create, ...existing];
}
