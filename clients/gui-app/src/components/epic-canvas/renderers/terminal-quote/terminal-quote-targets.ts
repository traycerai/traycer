import { displayTitle } from "@/lib/display-title";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

export interface TerminalQuoteChatTarget {
  readonly chatId: string;
  readonly title: string;
  /** The chat the primary action targets - shown first and marked in the menu. */
  readonly isLastFocused: boolean;
}

/**
 * The chats a terminal quote can be sent to, best target first.
 *
 * "Best" is the chat the user last focused a composer in - where they were
 * working - not the chat with the newest message, which during a long agent
 * turn is whichever agent happened to stream last. When nothing has been
 * focused yet (a freshly opened Task), the most recently updated chat is the
 * closest available stand-in, so the primary action is never dead while the
 * Task has chats to send to.
 *
 * Archived chats are excluded: they are hidden from the sidebar, so offering
 * one here would send a quote somewhere the user cannot see it.
 */
export function resolveTerminalQuoteChatTargets(
  chats: ChatsSlice,
  lastFocusedChatId: string | null,
): ReadonlyArray<TerminalQuoteChatTarget> {
  const active = chats.allIds.flatMap((id) => {
    if (!Object.hasOwn(chats.byId, id)) return [];
    const chat = chats.byId[id];
    if (chat.archivedAt !== null) return [];
    return [chat];
  });
  const hasLastFocused = active.some((chat) => chat.id === lastFocusedChatId);
  return active
    .toSorted((left, right) => {
      if (left.id === lastFocusedChatId) return -1;
      if (right.id === lastFocusedChatId) return 1;
      return right.updatedAt - left.updatedAt;
    })
    .map((chat) => ({
      chatId: chat.id,
      // Addressed as the durable Agent, matching every other chat surface.
      title: displayTitle(chat.title, "agent"),
      // Only a real focus record earns the mark; the recency fallback is a
      // guess and must not claim to be where the user was last working.
      isLastFocused: hasLastFocused && chat.id === lastFocusedChatId,
    }));
}
