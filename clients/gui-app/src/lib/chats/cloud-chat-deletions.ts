import { create } from "zustand";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";

interface CloudChatDeletionIdentity {
  readonly taskId: string;
  readonly ownerUserId: string;
  readonly ownerHostId: string;
  readonly chatId: string;
}

interface CloudChatDeletions {
  readonly pending: ReadonlyMap<string, string>;
  readonly confirmed: ReadonlySet<string>;
}

/**
 * A local delete outranks a stale cloud-list answer. Keep that fact outside
 * the query cache so a refetch cannot resurrect the backup as a sidebar row.
 * Success also refetches the list: the owning host filters its tombstones,
 * but another host can still return the backup until cloud retraction arrives.
 * Confirmed entries live for this renderer's lifetime, like record retractions.
 */
export const useCloudChatDeletions = create<CloudChatDeletions>(() => ({
  pending: new Map(),
  confirmed: new Set(),
}));

// A fork can leave the same chatId alive on another host. Never suppress that
// lineage: the mutation host must match the cloud row's ownerHostId. A mismatch
// deliberately leaves the row visible rather than hiding another host's chat.
function deletionKey(identity: CloudChatDeletionIdentity): string {
  return JSON.stringify([
    identity.taskId,
    identity.ownerUserId,
    identity.ownerHostId,
    identity.chatId,
  ]);
}

export function beginCloudChatDeletion(
  identity: CloudChatDeletionIdentity,
): string {
  const token = crypto.randomUUID();
  useCloudChatDeletions.setState((state) => ({
    pending: new Map(state.pending).set(token, deletionKey(identity)),
  }));
  return token;
}

export function settleCloudChatDeletion(
  token: string | null,
  succeeded: boolean,
): void {
  if (token === null) return;
  useCloudChatDeletions.setState((state) => {
    const key = state.pending.get(token);
    if (key === undefined) return state;
    const pending = new Map(state.pending);
    pending.delete(token);
    return {
      pending,
      confirmed: succeeded
        ? new Set(state.confirmed).add(key)
        : state.confirmed,
    };
  });
}

/** Replace a provisional cache-derived identity with the host's answer atomically. */
export function confirmCloudChatDeletion(
  token: string | null,
  identity: CloudChatDeletionIdentity,
): void {
  useCloudChatDeletions.setState((state) => {
    const pending = new Map(state.pending);
    if (token !== null) pending.delete(token);
    return {
      pending,
      confirmed: new Set(state.confirmed).add(deletionKey(identity)),
    };
  });
}

export function filterDeletedCloudChats(
  chats: readonly CloudChatSummary[],
  deletions: CloudChatDeletions,
): readonly CloudChatSummary[] {
  if (deletions.pending.size === 0 && deletions.confirmed.size === 0)
    return chats;
  const hidden = new Set([
    ...deletions.confirmed,
    ...deletions.pending.values(),
  ]);
  const visible = chats.filter(
    (chat) =>
      !hidden.has(
        deletionKey({ ...chat.identity, ownerHostId: chat.ownerHostId }),
      ),
  );
  return visible.length === chats.length ? chats : visible;
}
