/**
 * Dual-key identity for the per-tab chat UI restoration family (ticket 15;
 * decision #29). The tab key (`tileInstanceId`) is primary - unchanged from
 * ticket 5, unique per open, evicted outright when the tab permanently
 * closes. The chat key is durable (`${epicId}:${chatId}`, the
 * `chatSessionKey` precedent in `session-registry.ts:283`): it survives a
 * close/reopen and is shared last-writer-wins across every view of the same
 * chat, so reopening a closed chat can restore even though its old
 * `tileInstanceId` is gone for good.
 *
 * Every registry in the family (scroll cache, A2A/activity-group/tool/
 * subagent open state, tile-find session, minimap active entry) derives its
 * two keys through this one module so the format never drifts between them.
 */
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
