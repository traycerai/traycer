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

/**
 * The same question once the changes panel may be folded into a chip.
 *
 * A folded changes panel takes the whole pinned stack with it only when the
 * todo panel is not also in there - which is why this cannot be a `&&` at the
 * call site. Both the dock (which mounts the stack) and the surface around it
 * (which sizes everything below the dock from the same answer) read it here, so
 * a folded row can never leave a bordered empty box or the composer's
 * "connected" top spacing under nothing.
 */
export function chatPinnedStackVisible(input: {
  readonly todo: PinnedTodoSnapshot | null;
  readonly restore: ChatRestoreContextValue;
  readonly changesFolded: boolean;
}): boolean {
  if (input.todo !== null) return true;
  return !input.changesFolded && chatChangesPanelHasContent(input.restore);
}
