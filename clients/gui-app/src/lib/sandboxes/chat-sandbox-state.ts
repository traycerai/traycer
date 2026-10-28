import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { TaskSandboxEndedHost } from "@/hooks/epic/use-task-sandbox-end";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";

/** A sandbox between two states. */
export type SandboxMovingState =
  | "creating"
  | "resuming"
  | "starting"
  | "suspending"
  | "stopping"
  | "destroying";

/**
 * A chat's host as a sandbox. `none` is a host that is not a sandbox, or an
 * awake one this device reaches; `moving` is a sandbox between two states;
 * `pending` is one whose state is not known here yet, named when anything
 * names it. A sandbox chat never reads as `none` while its state is unknown,
 * so it never borrows the offline-host copy.
 */
export type ChatSandboxState =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly name: string | null }
  | {
      readonly kind: "moving";
      readonly sandbox: SandboxSummary;
      readonly state: SandboxMovingState;
    }
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

const MOVING_VERB: Record<SandboxMovingState, string> = {
  creating: "Starting",
  starting: "Starting",
  resuming: "Resuming",
  suspending: "Suspending",
  stopping: "Stopping",
  destroying: "Destroying",
};

/** A moving sandbox's line, as its row and setup line say it. */
export function movingSandboxLine(
  state: Extract<ChatSandboxState, { readonly kind: "moving" }>,
): string {
  return `${MOVING_VERB[state.state]} ${state.sandbox.displayName} · pending`;
}
