/**
 * Opener "TUI agents" sub-page: pinned "Create new TUI agent" (opens the shared
 * New Conversation modal in terminal mode - harness / model / args are chosen
 * inside the modal's terminal panel, and the agent places into this pane's
 * target group on launch) then existing tui-agents from the live projection.
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  openerActionLeaf,
  openerExistingLeaf,
} from "@/lib/commands/sources/open/open-leaf";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export function useTuiOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const projection = useActiveEpicProjection(ctx.activeEpicId);
  return useMemo<ReadonlyArray<CommandItem>>(() => {
    const newTui = openerActionLeaf({
      id: "open:tui:new",
      label: "Create new TUI agent",
      keywords: ["new", "tui", "agent", "terminal agent"],
      run: () => {
        if (ctx.activeEpicId === null || ctx.activeTabId === null) return;
        if (ctx.targetGroupId === null) return;
        useNewConversationModalStore
          .getState()
          .setComposerMode(ctx.activeEpicId, "terminal");
        useNewConversationModalOpenStore.getState().open({
          epicId: ctx.activeEpicId,
          tabId: ctx.activeTabId,
          placement: { kind: "target-group", groupId: ctx.targetGroupId },
          parentId: null,
        });
      },
    });
    if (projection === null) return [newTui];
    const existing = projection.tuiAgents.allIds.map((id) => {
      const agent = projection.tuiAgents.byId[id];
      return openerExistingLeaf("tui", ctx, {
        id: agent.id,
        instanceId: uuidv4(),
        type: "terminal-agent",
        name: agent.title.length > 0 ? agent.title : "Untitled terminal agent",
        hostId: agent.hostId,
      });
    });
    return [newTui, ...existing];
  }, [ctx, projection]);
}
