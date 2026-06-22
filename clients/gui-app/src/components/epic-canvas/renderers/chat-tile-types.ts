import type { InterviewQuestion } from "@traycer/protocol/persistence/epic/schemas";

export type ChatRuntimeAvailability =
  | {
      readonly kind: "available";
      readonly licenseKey: string;
    }
  | {
      readonly kind: "loading";
    }
  | {
      readonly kind: "unavailable";
    }
  | {
      readonly kind: "error";
      readonly message: string;
    };

export interface ChatRuntimeGate {
  readonly availability: ChatRuntimeAvailability;
  readonly retrying: boolean;
  readonly retry: () => Promise<unknown>;
}

export interface PendingInterviewView {
  readonly blockId: string;
  readonly toolName: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly questions: ReadonlyArray<InterviewQuestion>;
}
