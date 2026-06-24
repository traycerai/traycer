import type { InterviewQuestion } from "@traycer/protocol/persistence/epic/schemas";

export interface PendingInterviewView {
  readonly blockId: string;
  readonly toolName: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly questions: ReadonlyArray<InterviewQuestion>;
}
