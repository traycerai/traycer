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
 * A chat's host as a sandbox, by one precedence: the task's end record, then
 * a listed row's known state, then a move, then unknown.
 *
 * - `none` - proven not a sandbox (a person's host), or an awake sandbox this
 *   device reaches. A failed, disabled or missing read never proves it.
 * - `resting` - suspended, stopped or frozen. `configuration` is `null` until
 *   the team configuration it bills under resolves.
 * - `moving` - between two states, or destroyed before the task records the
 *   end.
 * - `pending` - not known here, named when anything names it.
 */
export type ChatSandboxState =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly name: string | null }
  | {
      readonly kind: "moving";
      readonly sandbox: SandboxSummary;
      readonly state: SandboxMovingState;
    }
  | { readonly kind: "failed"; readonly sandbox: SandboxSummary }
  | { readonly kind: "released"; readonly sandbox: SandboxSummary }
  | { readonly kind: "destroyed"; readonly ended: TaskSandboxEndedHost }
  | {
      readonly kind: "resting";
      readonly sandbox: SandboxSummary;
      readonly configuration: StageConfiguration | null;
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

/** A sandbox whose state this device cannot tell yet. */
export function unknownSandboxLine(name: string | null): string {
  return `${name ?? "This chat's sandbox"} isn't available — this chat stays readable.`;
}

/** A moving sandbox's line, as its row and setup line say it. */
export function movingSandboxLine(
  state: Extract<ChatSandboxState, { readonly kind: "moving" }>,
): string {
  return `${MOVING_VERB[state.state]} ${state.sandbox.displayName} · pending`;
}
