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
