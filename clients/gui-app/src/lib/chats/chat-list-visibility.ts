import type { ChatProjection } from "@/stores/epics/open-epic/types";

/**
 * Whether chat lists treat this chat as archived: it IS archived, or it is an
 * identity's evolution chat.
 *
 * An evolution chat is the host's own background review pass, not something
 * the user started, so it is hidden from every default list and shown under
 * Archived - which is also where it ends up for good, since the host archives
 * it when the pass terminates. Folding it into the archive partition, rather
 * than filtering it separately, is what keeps "absent by default, present
 * under Archived, dimmed under All" one rule with one reader. The
 * communication graph deliberately does NOT read this: it keeps the pass as a
 * child of the chat that spawned it.
 */
export function chatListedAsArchived(
  chat: Pick<ChatProjection, "archivedAt" | "chatKind">,
): boolean {
  return chat.archivedAt !== null || chat.chatKind === "evolution";
}
