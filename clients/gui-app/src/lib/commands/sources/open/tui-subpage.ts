/**
 * Terminal-interface half of the opener's unified **Agents** sub-page (see
 * `agents-subpage.ts`): the "New agent (Terminal)" creation leaf - harness /
 * model / args are chosen inside the modal's terminal panel, and the agent
 * places into this pane's target group on launch - plus the Task's existing
 * terminal-interface Agents from the live projection.
 *
 * Returns the creation leaf SEPARATELY from the records; see the chat half for
 * why. The `open:tui:*` leaf ids map to the `open_terminal` analytics command
 * and are preserved verbatim across the category merge.
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  openerActionLeaf,
  openerExistingLeaf,
} from "@/lib/commands/sources/open/open-leaf";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import type { OpenerInterfaceItems } from "@/lib/commands/sources/open/agents-subpage";
import type { CommandContext } from "@/lib/commands/types";

export function useTuiOpenerItems(ctx: CommandContext): OpenerInterfaceItems {
  const projection = useActiveEpicProjection(ctx.activeEpicId);
  return useMemo<OpenerInterfaceItems>(() => {
    const newTui = openerActionLeaf({
      id: "open:tui:new",
      label: "New agent (Terminal)",
      keywords: ["new", "tui", "terminal", "agent", "create"],
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
    if (projection === null) return { create: newTui, existing: [] };
    const existing = projection.tuiAgents.allIds.map((id) => {
      const agent = projection.tuiAgents.byId[id];
      return openerExistingLeaf("tui", ctx, {
        id: agent.id,
        instanceId: uuidv4(),
        type: "terminal-agent",
        name: displayTitle(agent.title, "agent"),
        hostId: agent.hostId,
      });
    });
    return { create: newTui, existing };
  }, [ctx, projection]);
}
