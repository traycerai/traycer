import type { ChatMessage } from "@/stores/composer/chat-store";

/**
 * The rendered row that carries a persisted message (Tracy Bots).
 *
 * A user row's `conversationRequest.resolvedByMessageId` names the REPLY'S
 * MESSAGE id, but the transcript scrolls by RENDERED ROW key, and an
 * assistant row's key is not its message id: a row with no turn is keyed
 * `assistant:ts:<timestamp>`, and a multi-record turn renders as one row
 * carrying every record's id in `turnMessageIds` with the last record's id
 * as `persistentMessageId`. So the jump resolves the message to the row that
 * renders it, and only then asks the list to land there. `null` when no
 * rendered row carries it - the reply is outside the hydrated window and
 * has to be located and loaded first.
 */
export function replyRowIdFor(
  messages: ReadonlyArray<ChatMessage>,
  messageId: string,
): string | null {
  for (const message of messages) {
    if (message.persistentMessageId === messageId) return message.id;
    if (message.turnMessageIds?.includes(messageId) === true) return message.id;
  }
  return null;
}
