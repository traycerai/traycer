import { chatRecordKey } from "./chat-record-head";

// Beside the record table, not on `ChatProjection`: the projection is filtered to the
// signed-in owner, and a team computer's chat is the team's. The host never patches
// the field, so a row without it retracts nothing; only the chat's removal does.

export interface ChatRecordStarterRow {
  readonly ownerUserId: string;
  readonly chatId: string;
  readonly starterUserId?: string | undefined;
}

export const EMPTY_CHAT_RECORD_STARTERS: Readonly<Record<string, string>> =
  Object.freeze({});

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
