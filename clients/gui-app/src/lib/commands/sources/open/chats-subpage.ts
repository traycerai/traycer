/**
 * Opener "Chats" sub-page: pinned "Create new chat" (opens the shared New
 * Conversation modal in chat mode, placing the result into this pane's target
 * group on submit) on top, then existing chats from the live projection (each
 * opens a fresh instance into the target group).
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_EPIC_NODE_NAMES } from "@/lib/artifacts/node-display";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  openerActionLeaf,
  openerExistingLeaf,
} from "@/lib/commands/sources/open/open-leaf";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export function useChatsOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const defaultHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const projection = useActiveEpicProjection(ctx.activeEpicId);

  return useMemo<ReadonlyArray<CommandItem>>(() => {
    const newChat = openerActionLeaf({
      id: "open:chats:new",
      label: "Create new chat",
      keywords: ["new", "chat", "create"],
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
    if (projection === null) return [newChat];
    const existing = projection.chats.allIds.map((id) => {
      const chat = projection.chats.byId[id];
      return openerExistingLeaf("chats", ctx, {
        id: chat.id,
        instanceId: uuidv4(),
        type: "chat",
        name: chat.title.length > 0 ? chat.title : DEFAULT_EPIC_NODE_NAMES.chat,
        hostId: chat.hostId ?? defaultHostId,
      });
    });
    return [newChat, ...existing];
  }, [ctx, projection, defaultHostId]);
}
