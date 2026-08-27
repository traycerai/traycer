/**
 * Opener **Agents** sub-page - the single Agent category in the pane opener.
 *
 * Agent is the durable entity a user opens; Chat and Terminal are the
 * interfaces it is interacted with through. Peer "Chat agents" / "Terminal
 * agents" categories restated the interface as an entity collection, so the two
 * are merged here into one category listing every Agent in the Task.
 *
 * Layout: both creation leaves first, then the canonical mixed-interface Agent
 * tree from the Epic projection. This is the same parent/child structure and
 * default ordering used by the sidebar, so a child remains findable beneath
 * the Agent that spawned it instead of disappearing into a long flat list.
 *
 * Composition, not reimplementation: the per-interface hooks still own their
 * own leaves, so `open:chats:*` / `open:tui:*` ids (and therefore the
 * `open_chat` / `open_terminal` analytics routing keyed on those prefixes in
 * `palette-cmdk-controller.ts`) are untouched by the merge.
 */
import { agentActivityTiers } from "@/lib/agent-activity";
import { useEpicAgentActivity } from "@/stores/agent-activity-store";
import { useChatsOpenerItems } from "@/lib/commands/sources/open/chats-subpage";
import { useTuiOpenerItems } from "@/lib/commands/sources/open/tui-subpage";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import { projectTreeSlice } from "@/stores/epics/open-epic/projection-helpers";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

/**
 * One interface's contribution to the Agents sub-page. `create` is kept out of
 * `existing` so the merged page can group creation entries at the top rather
 * than interleaving them between the two interfaces' records.
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
  // The command palette subscribes to the passive registry projection outside
  // EpicSessionProvider. Its independently cached `tree` index can briefly be
  // empty while the record slices are already populated (the sidebar, inside
  // the provider, does not have that gap). Derive from the authoritative live
  // records here so opening the Agents page never collapses to creation-only.
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
