import { displayTitle } from "@/lib/display-title";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

export interface TerminalQuoteChatTarget {
  readonly chatId: string;
  readonly title: string;
  /** Already tiled in the terminal's own view tab - listed ahead of the rest. */
  readonly isOpen: boolean;
  /** The chat the user last focused a composer in. Marked, never reordered. */
  readonly isLastFocused: boolean;
  /**
   * Bound to a host other than the terminal's, so its agent could not resolve
   * the terminal a chip would name. Marked, never reordered or dropped - the
   * chat is real and the user knows it is there, so the roster owes them the
   * row and the reason rather than a silent omission.
   */
  readonly isOnOtherHost: boolean;
}

export interface TerminalQuoteChatTargetsInput {
  /** Every chat in the Task, in the order the chats sidebar lists them. */
  readonly orderedChatIds: readonly string[];
  readonly chats: ChatsSlice;
  /** Content ids of the tiles open in the terminal's own view tab. */
  readonly openChatIds: ReadonlySet<string>;
  readonly lastFocusedChatId: string | null;
  /** The host the terminal tile is bound to - the one its session lives on. */
  readonly terminalHostId: string;
}

/**
 * The chats a terminal selection can be sent to.
 *
 * Two bands, and the order within each is the sidebar's. Chats already open in
 * this view come first because they are where the user is working right now -
 * the selection is nearly always headed for something already on screen, and a
 * list that opens with the four chats they can see reads as "pick one of
 * these" rather than "search the Task". Everything else follows in the exact
 * order the sidebar shows it, so the two lists never disagree about where a
 * chat sits; recency is deliberately NOT the rule here, because during a long
 * agent turn the most recently updated chat is just whichever agent streamed
 * last.
 *
 * Archived chats are excluded: they are hidden from the sidebar, so offering
 * one here would send a message somewhere the user cannot see it.
 *
 * A chat on ANOTHER host is kept, marked rather than removed. The terminal is
 * local to the tile's host, so its agent has no way to resolve a chip naming
 * it - but dropping the row would leave the user hunting for a chat they can
 * see in the sidebar. A legacy chat with no recorded host is not on another
 * one: opening it adopts the tab's host (`chat.hostId ?? tabHostId`), so it is
 * offered exactly like a same-host chat.
 */
export function resolveTerminalQuoteChatTargets(
  input: TerminalQuoteChatTargetsInput,
): ReadonlyArray<TerminalQuoteChatTarget> {
  const rows = input.orderedChatIds.flatMap((chatId) => {
    if (!Object.hasOwn(input.chats.byId, chatId)) return [];
    const chat = input.chats.byId[chatId];
    if (chat.archivedAt !== null) return [];
    return [
      {
        chatId: chat.id,
        // Addressed as the durable Agent, matching every other chat surface.
        title: displayTitle(chat.title, "agent"),
        isOpen: input.openChatIds.has(chat.id),
        isLastFocused: chat.id === input.lastFocusedChatId,
        isOnOtherHost:
          chat.hostId !== null && chat.hostId !== input.terminalHostId,
      },
    ];
  });
  return [
    ...rows.filter((row) => row.isOpen),
    ...rows.filter((row) => !row.isOpen),
  ];
}
