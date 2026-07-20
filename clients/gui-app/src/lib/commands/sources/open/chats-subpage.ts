/**
 * Opener "Chats" sub-page: pinned "Create new chat" (opens the shared New
 * Conversation modal in chat mode, placing the result into this pane's target
 * group on submit) on top, then existing chats from the live projection (each
 * opens a fresh instance into the target group).
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_EPIC_NODE_NAMES } from "@/lib/artifacts/node-display";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
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
  const activeHostId = useReactiveActiveHostId();
  const defaultHostId = activeHostId ?? UNKNOWN_HOST_PLACEHOLDER;
  const projection = useActiveEpicProjection(ctx.activeEpicId);
  const directoryList = useHostDirectoryList();
  const hostLabelById = useMemo(() => {
    return new Map(
      (directoryList.data ?? []).map((entry) => [entry.hostId, entry.label]),
    );
  }, [directoryList.data]);

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
      // A chat with no recorded hostId falls back to (and thus matches) the
      // active host, so only a real, differing hostId ever earns a badge.
      // Requires `activeHostId` to be genuinely resolved first - while it's
      // still `null` (boot, host reconnect window) `defaultHostId` would be
      // the `UNKNOWN_HOST_PLACEHOLDER` sentinel, which no real hostId can
      // ever equal, false-badging every chat as cross-host.
      const hostBadge =
        activeHostId !== null &&
        chat.hostId !== null &&
        chat.hostId !== activeHostId
          ? chatHostBadgeLabel(hostLabelById, chat.hostId)
          : null;
      return openerExistingLeaf(
        "chats",
        ctx,
        {
          id: chat.id,
          instanceId: uuidv4(),
          type: "chat",
          name:
            chat.title.length > 0 ? chat.title : DEFAULT_EPIC_NODE_NAMES.chat,
          hostId: chat.hostId ?? defaultHostId,
        },
        hostBadge,
      );
    });
    return [newChat, ...existing];
  }, [ctx, projection, activeHostId, defaultHostId, hostLabelById]);
}

/** Falls back to the raw hostId when the directory has no (or a blank) label for it. */
function chatHostBadgeLabel(
  hostLabelById: ReadonlyMap<string, string>,
  hostId: string,
): string {
  const label = hostLabelById.get(hostId);
  return label !== undefined && label.length > 0 ? label : hostId;
}
