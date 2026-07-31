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
