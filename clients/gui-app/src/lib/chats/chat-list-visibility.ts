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
 * under Archived, dimmed under All" one rule with one reader.
 */
export function chatListedAsArchived(
  chat: Pick<ChatProjection, "archivedAt" | "chatKind">,
): boolean {
  return chat.archivedAt !== null || chat.chatKind === "evolution";
}

/**
 * Whether the communication graph draws this chat as an agent at all.
 *
 * The graph has no archive partition to fold an evolution chat into - an
 * archived agent is ALWAYS drawn there, muted, because the graph is
 * historical - so the pass is left out instead of being shown as an ordinary
 * active node. Its `archivedAt` cannot stand in: the pass runs with a `null`
 * one until the host archives it at termination, which is exactly the window
 * in which it would otherwise sit on the floor as a live agent.
 */
export function chatShownInCommGraph(
  chat: Pick<ChatProjection, "chatKind">,
): boolean {
  return chat.chatKind !== "evolution";
}
