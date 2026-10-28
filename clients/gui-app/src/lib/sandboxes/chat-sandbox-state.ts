import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { TaskSandboxEndedHost } from "@/hooks/epic/use-task-sandbox-end";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";

/**
 * A chat's host as a sandbox. `none` is a host that is not a sandbox, or an
 * awake one this device reaches; `pending` is a sandbox whose state is moving
 * or not known here yet, named when anything names it. A sandbox chat never
 * reads as `none` while its state is unknown, so it never borrows the
 * offline-host copy.
 */
export type ChatSandboxState =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly name: string | null }
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

/** Sending can wake an owned chat; stream and approval rights stay separate. */
export function restingChatSandbox(
  state: ChatSandboxState,
  canEdit: boolean,
  ownership: {
    readonly ownedByViewer: boolean;
    readonly environmentOwned: boolean;
  },
): Extract<ChatSandboxState, { readonly kind: "resting" }> | undefined {
  if (
    state.kind !== "resting" ||
    !canEdit ||
    !(ownership.ownedByViewer || ownership.environmentOwned)
  )
    return undefined;
  return state;
}
