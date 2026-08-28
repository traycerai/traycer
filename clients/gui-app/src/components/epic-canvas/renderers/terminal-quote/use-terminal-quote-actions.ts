import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";

import {
  appendTerminalQuoteToDraft,
  appendTerminalQuoteToNewConversationDraft,
} from "@/components/chat/quote/append-terminal-quote-to-draft";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { ACTIVE_TILE_PLACEMENT } from "@/lib/canvas/conversation-tile-placement";
import { displayTitle } from "@/lib/display-title";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

interface UseTerminalQuoteActionsArgs {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly terminalId: string;
  readonly terminalTitle: string;
  /** The shell's launch directory; `null` until the host's row is available. */
  readonly terminalCwd: string | null;
}

export interface TerminalQuoteActions {
  /** Quotes into an existing chat, then brings that chat forward. */
  readonly quoteToChat: (chatId: string, text: string) => void;
  /**
   * Opens the New Conversation modal with the quote already in its composer.
   * Nothing is created until the user sends.
   */
  readonly quoteToNewChat: (text: string) => void;
}

/**
 * Sends a terminal selection into a chat's composer draft and puts that chat in
 * front of the user. Never submits - the quote is a starting point for a
 * message the user still writes.
 */
export function useTerminalQuoteActions(
  args: UseTerminalQuoteActionsArgs,
): TerminalQuoteActions {
  const { epicId, viewTabId, terminalId, terminalTitle, terminalCwd } = args;
  const handle = useOpenEpicHandle();
  const tabHostId = useTabHostId();
  const navigateNested = useEpicNestedFocusNavigation();
  const openNewConversationModal = useNewConversationModalOpenStore(
    (state) => state.open,
  );
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (state) => state.prepareSetActiveTileTabFocusTarget,
  );

  const revealChat = useCallback(
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

  const quoteToChat = useCallback(
    (chatId: string, text: string) => {
      // Draft first: a composer that is not mounted yet reads this as its
      // initial content, and one that is already mounted syncs and focuses on
      // the store bump. Either way the quote is there before the tile lands.
      appendTerminalQuoteToDraft(chatId, {
        epicId,
        terminalId,
        terminalTitle,
        terminalCwd,
        text,
      });
      revealChat(chatId);
    },
    [epicId, revealChat, terminalId, terminalTitle, terminalCwd],
  );

  const quoteToNewChat = useCallback(
    (text: string) => {
      // Draft first, then open: the modal's composer seeds itself from the
      // draft store as it mounts, so the quote has to be there already.
      appendTerminalQuoteToNewConversationDraft({
        epicId,
        terminalId,
        terminalTitle,
        terminalCwd,
        text,
      });
      openNewConversationModal({
        epicId,
        tabId: viewTabId,
        placement: ACTIVE_TILE_PLACEMENT,
        parentId: null,
        // This tile is bound to `tabHostId` for life and the quote points at a
        // terminal that only exists on that host, so the chat has to be created
        // there - not on whichever host happens to be active app-wide.
        hostId: tabHostId,
      });
    },
    [
      epicId,
      openNewConversationModal,
      tabHostId,
      terminalCwd,
      terminalId,
      terminalTitle,
      viewTabId,
    ],
  );

  return { quoteToChat, quoteToNewChat };
}
