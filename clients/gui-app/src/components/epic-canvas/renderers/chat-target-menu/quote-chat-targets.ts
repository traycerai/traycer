import { displayTitle } from "@/lib/display-title";
import type { ChatsSlice } from "@/stores/epics/open-epic/types";

export interface QuoteChatTarget {
  readonly chatId: string;
  readonly title: string;
  /** Already tiled in the source's own view tab - listed ahead of the rest. */
  readonly isOpen: boolean;
  /** The chat the user last focused a composer in. Marked, never reordered. */
  readonly isLastFocused: boolean;
  /**
   * Bound to a host other than the source's, so its agent could not resolve
   * what a chip would name. Marked, never reordered or dropped - the chat is
   * real and the user knows it is there, so the roster owes them the row and
   * the reason rather than a silent omission. Always false when the source
   * has no host affinity (`sourceHostId: null`).
   */
  readonly isOnOtherHost: boolean;
}

export interface QuoteChatTargetsInput {
  /** Every chat in the Task, in the order the chats sidebar lists them. */
  readonly orderedChatIds: readonly string[];
  readonly chats: ChatsSlice;
  /** Content ids of the tiles open in the source's own view tab. */
  readonly openChatIds: ReadonlySet<string>;
  readonly lastFocusedChatId: string | null;
  /**
   * The host the quoted thing lives on, or `null` when it lives on none in
   * particular. A terminal session exists on exactly one host, so a chat bound
   * elsewhere cannot be sent it; an artifact is projected onto every host
   * serving the epic, so every chat can take it.
   */
  readonly sourceHostId: string | null;
}

/**
 * The chats a quoted selection can be sent to.
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
 * A chat on ANOTHER host than the source is kept, marked rather than removed.
 * Dropping the row would leave the user hunting for a chat they can see in the
 * sidebar. A legacy chat with no recorded host is not on another one: opening
 * it adopts the tab's host (`chat.hostId ?? tabHostId`), so it is offered
 * exactly like a same-host chat.
 */
export function resolveQuoteChatTargets(
  input: QuoteChatTargetsInput,
): ReadonlyArray<QuoteChatTarget> {
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
          input.sourceHostId !== null &&
          chat.hostId !== null &&
          chat.hostId !== input.sourceHostId,
      },
    ];
  });
  return [
    ...rows.filter((row) => row.isOpen),
    ...rows.filter((row) => !row.isOpen),
  ];
}
