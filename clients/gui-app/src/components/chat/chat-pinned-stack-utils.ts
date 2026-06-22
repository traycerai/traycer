import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";

export function hasChatPinnedStackContent(
  todo: PinnedTodoSnapshot | null,
  restore: ChatRestoreContextValue,
): boolean {
  return todo !== null || restore.accumulatedFileChanges.length > 0;
}
