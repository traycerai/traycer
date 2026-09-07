/** Dual-key identity for the per-tab chat UI restoration family (ticket 15; decision #29). */
export interface ChatTabPersistenceIdentity {
  readonly tileInstanceId: string;
  readonly epicId: string;
  readonly chatId: string;
  /** Bound host when known; legacy/test callers may omit it. */
  readonly hostId?: string | null;
}

export function chatTabPersistenceTabKey(
  identity: Pick<ChatTabPersistenceIdentity, "tileInstanceId">,
): string {
  return identity.tileInstanceId;
}

export function chatTabPersistenceChatKey(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): string {
  return `${identity.epicId}:${identity.chatId}`;
}
