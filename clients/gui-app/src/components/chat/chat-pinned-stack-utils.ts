import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";

/** Both, because on the windowed line the snapshot carries the authoritative `accumulatedFileChangeCount` and the summaries arrive afterwards in chunks - which is the NORMAL delivery order, not a degraded one. */
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
