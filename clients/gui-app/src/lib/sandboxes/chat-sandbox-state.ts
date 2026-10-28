import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { TaskSandboxEndedHost } from "@/hooks/epic/use-task-sandbox-end";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";

export type ChatSandboxState =
  | { readonly kind: "none" }
  | { readonly kind: "destroyed"; readonly ended: TaskSandboxEndedHost }
  | {
      readonly kind: "resting";
      readonly sandbox: SandboxSummary;
      readonly configuration: StageConfiguration;
      readonly wakeChangesPayer: boolean;
    }
  | {
      readonly kind: "unreachable";
      readonly sandbox: SandboxSummary;
      readonly lastContactMinutes: number | null;
    };

/** A suspended, stopped or frozen sandbox: the next message wakes it. */
export type RestingChatSandbox = Extract<
  ChatSandboxState,
  { readonly kind: "resting" }
>;

/** Sending can wake an owned chat; stream and approval rights stay separate. */
export function restingChatSandbox(
  state: ChatSandboxState,
  canEdit: boolean,
  ownership: {
    readonly ownedByViewer: boolean;
    readonly environmentOwned: boolean;
  },
): RestingChatSandbox | undefined {
  if (
    state.kind !== "resting" ||
    !canEdit ||
    !(ownership.ownedByViewer || ownership.environmentOwned)
  )
    return undefined;
  return state;
}
