import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";

/**
 * Whether the changes panel has anything to show YET.
 *
 * The delivered rows OR the host's own count of rows still in flight. Both,
 * because on the windowed line the snapshot carries the authoritative
 * `accumulatedFileChangeCount` and the summaries arrive afterwards in chunks -
 * which is the NORMAL delivery order, not a degraded one. Gating on the
 * delivered array alone means a chat with changes renders as a chat with none
 * until the first chunk lands, and on a slow summary stream that is a
 * user-visible lie the panel is already equipped to tell the truth about: it
 * paints its collapsed header from the count and reports its own shortfall.
 */
export function chatChangesPanelHasContent(
  restore: ChatRestoreContextValue,
): boolean {
  return (
    restore.accumulatedFileChanges.length > 0 ||
    restore.undeliveredChangeCount > 0
  );
}

export function hasChatPinnedStackContent(
  todo: PinnedTodoSnapshot | null,
  restore: ChatRestoreContextValue,
): boolean {
  return todo !== null || chatChangesPanelHasContent(restore);
}
