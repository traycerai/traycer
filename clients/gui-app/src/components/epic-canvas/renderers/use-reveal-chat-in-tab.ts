import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";

import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { displayTitle } from "@/lib/display-title";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

/**
 * Puts a chat in front of the user inside a view tab: activates its tile if
 * one is already open there, otherwise opens one. Shared by every quote
 * surface (terminal, artifact) because the step after "put this in that
 * chat's draft" is always "and show me that chat".
 *
 * A chat that opens here is bound to `chat.hostId ?? tabHostId` - its own
 * recorded host, or the tab's for a legacy chat with none. Never the host of
 * whatever was quoted: the quote is content, not a binding.
 */
export function useRevealChatInTab(args: {
  readonly epicId: string;
  readonly viewTabId: string;
}): (chatId: string) => void {
  const { epicId, viewTabId } = args;
  const handle = useOpenEpicHandle();
  const tabHostId = useTabHostId();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (state) => state.prepareSetActiveTileTabFocusTarget,
  );

  return useCallback(
    (chatId: string) => {
      const alreadyOpen = findOpenArtifactInTab(viewTabId, chatId);
      if (alreadyOpen !== null) {
        navigateNested(epicId, viewTabId, () =>
          prepareSetActiveTileTabFocusTarget(
            viewTabId,
            alreadyOpen.paneId,
            alreadyOpen.instanceId,
          ),
        );
        return;
      }
      const chats = handle.store.getState().chats;
      if (!Object.hasOwn(chats.byId, chatId)) return;
      const chat = chats.byId[chatId];
      navigateNested(epicId, viewTabId, () =>
        prepareOpenTileInTabFocusTarget(viewTabId, {
          id: chat.id,
          instanceId: uuidv4(),
          type: "chat",
          name: displayTitle(chat.title, "agent"),
          hostId: chat.hostId ?? tabHostId,
        }),
      );
    },
    [
      epicId,
      handle,
      navigateNested,
      prepareOpenTileInTabFocusTarget,
      prepareSetActiveTileTabFocusTarget,
      tabHostId,
      viewTabId,
    ],
  );
}
