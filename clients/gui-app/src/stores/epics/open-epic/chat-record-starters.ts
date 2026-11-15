import { chatRecordKey } from "./chat-record-head";

/**
 * Who started each chat, as the host that holds it says on the chat's row
 * (`epic.listChatRecords@1.5`, `host.chatRecords.subscribe@1.5`): a user id or
 * the literal `"system"`, keyed by `chatRecordKey(ownerUserId, chatId)`.
 *
 * Beside the record table rather than on `ChatProjection`, as the head is:
 * the projection is filtered to the signed-in owner, and the starter is read
 * for a chat on a team's computer, whose owner is the team.
 *
 * The host sets the field with the record and never patches it, so a row
 * without it says nothing: an older host's row, or another computer's replica
 * row. Neither retracts a held starter; only the chat's removal does.
 */

/** One row's contribution: the record identity and its starter, if stated. */
export interface ChatRecordStarterRow {
  readonly ownerUserId: string;
  readonly chatId: string;
  readonly starterUserId?: string | undefined;
}

export const EMPTY_CHAT_RECORD_STARTERS: Readonly<Record<string, string>> =
  Object.freeze({});

/** The table after folding `rows` in, or the SAME table when nothing moved. */
export function applyChatRecordStarterRows(
  held: Readonly<Record<string, string>>,
  rows: Iterable<ChatRecordStarterRow>,
): Readonly<Record<string, string>> {
  let next: Record<string, string> | null = null;
  for (const row of rows) {
    const starter = row.starterUserId;
    if (starter === undefined) continue;
    const key = chatRecordKey(row.ownerUserId, row.chatId);
    const current = next ?? held;
    if (Object.hasOwn(current, key) && current[key] === starter) continue;
    next ??= { ...held };
    next[key] = starter;
  }
  return next ?? held;
}
