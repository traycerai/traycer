import { useSyncExternalStore } from "react";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

/**
 * One in-flight sharing write per (task, viewer).
 *
 * The host coordinator queues by method + full params, so
 * `epic.setChatSharingDefault` and `epic.setCloudChatVisibility` never share a
 * queue — a paused share-all can resume after a later make-private and
 * re-expose the chat. This gate is the actual ordering: a second request is
 * refused, not queued, so the last user action cannot be overtaken.
 */

const pendingScopes = new Set<string>();
const listeners = new Set<() => void>();

function scopeKey(taskId: string, viewerUserId: string): string {
  return `${taskId}\n${viewerUserId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function chatSharingInFlightScopeKey(
  taskId: string,
  viewerUserId: string,
): string {
  return scopeKey(taskId, viewerUserId);
}

export function beginChatSharingInFlight(
  taskId: string,
  viewerUserId: string,
): boolean {
  if (taskId.length === 0) return false;
  const key = scopeKey(taskId, viewerUserId);
  if (pendingScopes.has(key)) return false;
  pendingScopes.add(key);
  emit();
  return true;
}

export function endChatSharingInFlight(
  taskId: string,
  viewerUserId: string,
): void {
  if (!pendingScopes.delete(scopeKey(taskId, viewerUserId))) return;
  emit();
}

export function isChatSharingInFlight(
  taskId: string,
  viewerUserId: string,
): boolean {
  return pendingScopes.has(scopeKey(taskId, viewerUserId));
}

export function subscribeChatSharingInFlight(
  onStoreChange: () => void,
): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function resetChatSharingInFlightForTests(): void {
  pendingScopes.clear();
  emit();
}

/**
 * Whether any sharing write (master toggle or per-chat) is in flight for
 * this task and the signed-in viewer. Snapshot is a boolean so a
 * `useSyncExternalStore` subscription cannot loop.
 */
export function useChatSharingInFlight(taskId: string): boolean {
  const viewerUserId = useCloudChatViewerId();
  return useSyncExternalStore(subscribeChatSharingInFlight, () =>
    isChatSharingInFlight(taskId, viewerUserId),
  );
}

/** Distinguishes a refused second write from a real RPC failure. */
export const CHAT_SHARING_IN_FLIGHT_MESSAGE = "chat-sharing-in-flight";
