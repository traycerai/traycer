import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";

import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { displayTitle } from "@/lib/display-title";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";

/**
 * Puts a chat in front of the user inside a view tab. Shared by every quote
 * surface (terminal, artifact) because the step after "put this in that
 * chat's draft" is always "and show me that chat".
 *
 * `dedupe` is the "already on this canvas?" branch: a chat that is open is
 * brought forward, and only a chat that is not gets a fresh tile.
 *
 * A chat that opens here is bound to `chat.hostId ?? tabHostId` - its own
 * recorded host, or the tab's for a legacy chat with none. Never the host of
 * whatever was quoted: the quote is content, not a binding.
 */
export function useRevealChatInTab(args: {
  readonly epicId: string;
  readonly viewTabId: string;
}): (chatId: string) => void {
  const { viewTabId } = args;
  const handle = useOpenEpicHandle();
  const tabHostId = useTabHostId();
  const { openTile } = useEpicTileNavigation();

  return useCallback(
    (chatId: string) => {
      const chats = handle.store.getState().chats;
      if (!Object.hasOwn(chats.byId, chatId)) return;
      const chat = chats.byId[chatId];
      openTile(
        tileIntent(
          {
            id: chat.id,
            instanceId: uuidv4(),
            type: "chat",
            name: displayTitle(chat.title, "agent"),
            hostId: chat.hostId ?? tabHostId,
          },
          { tabId: viewTabId },
          "explicit",
          "direct_ui",
        ),
      );
    },
    [handle, openTile, tabHostId, viewTabId],
  );
}
