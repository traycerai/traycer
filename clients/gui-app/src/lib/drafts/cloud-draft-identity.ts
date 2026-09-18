import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";

/**
 * One published row in the personal drafts scope, as the ingest addresses
 * it. `CloudChatSummary` satisfies this, so callers pass the summary itself.
 */
export interface CloudDraftRowRef {
  readonly ownerHostId: string;
  readonly identity: CloudChatIdentity;
}

/**
 * Chat ids are host-minted, so identity is the `(task, owner, chat)` TRIPLE -
 * two hosts can mint the same chat id under one task. `ownerHostId` leads it
 * here because that triple identifies a row to the SERVER, which resolves one
 * row per identity, while the ingest tracks MANY hosts' rows at once: two
 * hosts' rows arriving under one triple would otherwise collapse into one
 * guard entry.
 */
export function cloudDraftIdentityKey(row: CloudDraftRowRef): string {
  const { identity } = row;
  return `${row.ownerHostId}:${identity.taskId}:${identity.ownerUserId}:${identity.chatId}`;
}
