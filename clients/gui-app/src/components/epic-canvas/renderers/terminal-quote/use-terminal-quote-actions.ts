import { useCallback, useEffect, useRef } from "react";
import { v4 as uuidv4 } from "uuid";

import { appendTerminalQuoteToDraft } from "@/components/chat/quote/append-terminal-quote-to-draft";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicCreateChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  openCreatedChatWhenProjectedWithNavigation,
  openNewChatInActiveTile,
  type CancelFn,
} from "@/lib/commands/actions/new-chat";
import { displayTitle } from "@/lib/display-title";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

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
  /** Creates a chat, pre-fills its draft with the quote, and opens it. */
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
  const createChat = useEpicCreateChat();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (state) => state.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (state) => state.prepareSetActiveTileTabFocusTarget,
  );

  // A new chat's tile opens only once the host's create round-trips and the
  // chat lands in the projection. Unmounting mid-wait must tear that watch
  // down, or it opens a tab in a tile that is gone.
  const pendingNewChat = useRef<CancelFn | null>(null);
  useEffect(
    () => () => {
      pendingNewChat.current?.();
      pendingNewChat.current = null;
    },
    [],
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
      pendingNewChat.current?.();
      pendingNewChat.current = openNewChatInActiveTile({
        epicId,
        tabId: viewTabId,
        hostId: tabHostId,
        // No worktree seed and no pinned settings: this is the same bare chat
        // the palette's "New chat" creates, and the chat tile resolves its
        // binding at send time.
        worktreeIntent: null,
        settings: null,
        source: "direct_ui",
        createChat: (request, callbacks) =>
          createChat.mutate(request, { onSuccess: callbacks.onSuccess }),
        openWhenProjected: (intent) => {
          appendTerminalQuoteToDraft(intent.chatId, {
            epicId,
            terminalId,
            terminalTitle,
            terminalCwd,
            text,
          });
          return openCreatedChatWhenProjectedWithNavigation({
            intent,
            navigateNestedFocus: navigateNested,
          });
        },
      });
    },
    [
      createChat,
      epicId,
      navigateNested,
      tabHostId,
      terminalCwd,
      terminalId,
      terminalTitle,
      viewTabId,
    ],
  );

  return { quoteToChat, quoteToNewChat };
}
