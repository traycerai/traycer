/**
 * What the chat surface reads off the tile ref that opened it.
 *
 * Structural rather than `EpicNodeRef` because the surface has two openers now:
 * an epic-tree chat, and a chat read from the copy its unreachable owning host
 * last published (`PublishedChatTileRef`). Those refs are addressed differently
 * on purpose - a published copy is keyed by the whole cloud identity triple,
 * since after a fork two lineages share one `chatId` - but the surface itself
 * only ever wanted these three fields. Naming them is what keeps the ONE chat
 * surface rule honest, instead of widening a union until a second view is
 * easier to write than a shared one.
 */
export interface ChatSurfaceNode {
  /** The chat id. The tile REF may be keyed more finely; this is not that key. */
  readonly id: string;
  readonly instanceId: string;
  readonly name: string;
}

import type { InterviewQuestion } from "@traycer/protocol/persistence/epic/schemas";

export interface PendingInterviewView {
  readonly blockId: string;
  readonly toolName: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly questions: ReadonlyArray<InterviewQuestion>;
  // Persistent id of the assistant message that owns this pending interview,
  // when it is a stable (non-transient) fork boundary. Drives "fork during
  // Q&A": forking here branches the chat so the user can cross-question the
  // assistant. null when the owning message has no forkable persistent id yet.
  readonly assistantMessageId: string | null;
}

/**
 * A host-pending interview this transcript can render no answer card for: its
 * interview block is either already settled (`completed` / `errored`) or is
 * absent from the transcript entirely. `findPendingInterview` only ever yields
 * a `streaming` block, so such a block produces no card while the host still
 * rejects every send with `DETACHED_INTERVIEW_PENDING` — a composer deadlock
 * with nothing to answer. These drive the dismiss affordance that is the only
 * in-chat way out.
 */
export interface UnanswerableInterviewView {
  readonly blockId: string;
  readonly requestedAt: number;
}
