import {
  routeNotificationForHost,
  type NotificationNavigate,
} from "@/lib/notifications";

export interface ChatSearchResultTarget {
  /** The host that answered the search: results are host-local. */
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  /** The row to land on; `null` opens the chat where the reader left it. */
  readonly messageId: string | null;
}

/**
 * Opens a search result on the chat tile bound to the host that answered it,
 * and parks a `message` jump for that tile.
 *
 * This is the route a chat notification with a message anchor already takes,
 * reused rather than restated: it focuses an open tile of that chat on that
 * host, reopens a closed one, or opens the task, and parks the jump in
 * `useChatTranscriptJumpStore` keyed by `(hostId, chatId)`. The chat tile
 * consumes it, and when the row is cold - an assistant record, whose rows are
 * turn-keyed - asks the host where it is through `useChatLocateRow` with the
 * same `message` locator, then centers the row.
 *
 * The dialog searches the effective host, so the two ids normally agree -
 * which is the condition under which the route parks a jump for a tile it has
 * to open fresh (a hostless epic intent resolves through the effective host).
 * They are passed separately so a selection move between the search and the
 * click opens the task without parking a jump another host's tile could take.
 */
export function openChatSearchResult(
  navigate: NotificationNavigate,
  target: ChatSearchResultTarget,
  context: { readonly effectiveHostId: string | null; readonly now: number },
): void {
  routeNotificationForHost(
    navigate,
    {
      kind: "chat",
      epicId: target.epicId,
      chatId: target.chatId,
      hostId: target.hostId,
      messageId: target.messageId ?? undefined,
      eventId: undefined,
    },
    context.now,
    { originHostId: target.hostId, effectiveHostId: context.effectiveHostId },
  );
}
