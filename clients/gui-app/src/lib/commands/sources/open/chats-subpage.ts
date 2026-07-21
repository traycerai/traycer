/**
 * Chat-interface half of the opener's unified **Agents** sub-page (see
 * `agents-subpage.ts`): the "New agent (Chat)" creation leaf plus the Task's
 * existing chat-interface Agents from the live projection (each opens a fresh
 * instance into the bound target group).
 *
 * Returns the creation leaf SEPARATELY from the records so the merged sub-page
 * can group both interfaces' creation entries at the top instead of
 * interleaving them - which would read as two entity collections again.
 *
 * The `open:chats:*` leaf ids are load-bearing beyond routing: the palette maps
 * that prefix to the `open_chat` analytics command
 * (`palette-cmdk-controller.ts`), so they survive the category merge unchanged.
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { displayTitle } from "@/lib/display-title";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  openerActionLeaf,
  openerExistingLeaf,
} from "@/lib/commands/sources/open/open-leaf";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import type { OpenerInterfaceItems } from "@/lib/commands/sources/open/agents-subpage";
import type { CommandContext } from "@/lib/commands/types";

export function useChatsOpenerItems(ctx: CommandContext): OpenerInterfaceItems {
  const defaultHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const projection = useActiveEpicProjection(ctx.activeEpicId);

  return useMemo<OpenerInterfaceItems>(() => {
    const newChat = openerActionLeaf({
      id: "open:chats:new",
      label: "New agent (Chat)",
      keywords: ["new", "chat", "agent", "create"],
      run: () => {
        if (ctx.activeEpicId === null || ctx.activeTabId === null) return;
        if (ctx.targetGroupId === null) return;
        useNewConversationModalStore
          .getState()
          .setComposerMode(ctx.activeEpicId, "chat");
        useNewConversationModalOpenStore.getState().open({
          epicId: ctx.activeEpicId,
          tabId: ctx.activeTabId,
          placement: { kind: "target-group", groupId: ctx.targetGroupId },
          parentId: null,
        });
      },
    });
    if (projection === null) return { create: newChat, existing: [] };
    const existing = projection.chats.allIds.map((id) => {
      const chat = projection.chats.byId[id];
      return openerExistingLeaf("chats", ctx, {
        id: chat.id,
        instanceId: uuidv4(),
        type: "chat",
        // Read surface: an untitled Agent renders the render-tier "Untitled
        // agent" fallback, NOT the creation-tier "New chat" default title.
        name: displayTitle(chat.title, "agent"),
        hostId: chat.hostId ?? defaultHostId,
      });
    });
    return { create: newChat, existing };
  }, [ctx, projection, defaultHostId]);
}
