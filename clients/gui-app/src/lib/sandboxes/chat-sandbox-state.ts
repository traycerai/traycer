import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { TaskSandboxEndedHost } from "@/hooks/epic/use-task-sandbox-end";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";
import {
  sandboxFailedChatLine,
  sandboxReleasedChatLine,
} from "@/lib/sandboxes/sandbox-row-lines";
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";

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
 * a listed row's known state, then a move, then a sandbox something names.
 *
 * - `none` - a host nothing names as a sandbox (the task, the directory and
 *   the viewer's sandbox list), or an awake sandbox this device reaches.
 * - `resting` - suspended, stopped or frozen. `configuration` is `null` until
 *   the team configuration it bills under resolves.
 * - `moving` - between two states, awake with a host yet to first report, or
 *   destroyed before the task records the end.
 * - `pending` - a sandbox the task or the directory names, its state not
 *   known here.
 */
export type ChatSandboxState =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly name: string }
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
      /** When its host last reported, epoch ms; `null` when it never has. */
      readonly lastContactAt: number | null;
    };

/**
 * A suspended, stopped or frozen sandbox whose configuration is known: the
 * next message wakes it, billed there.
 */
export type RestingChatSandbox = Extract<
  ChatSandboxState,
  { readonly kind: "resting" }
> & { readonly configuration: StageConfiguration };

type UnreachableChatSandbox = Extract<
  ChatSandboxState,
  { readonly kind: "unreachable" }
>;

/**
 * A sandbox chat's one line. `slot` takes the composer's place for every
 * role, and is the body before the transcript; `footer` sits under the chat
 * and leaves the composer to its mode. `text` is the line as one sentence,
 * for a surface that has room for nothing else (a sidebar row).
 */
export type ChatSandboxLine =
  | {
      readonly place: "slot";
      readonly text: string;
      readonly state: ChatSandboxState;
    }
  | {
      readonly place: "footer";
      readonly text: string;
      readonly state: RestingChatSandbox | UnreachableChatSandbox;
    };

/**
 * What the composer does: its surface's own path, the slot line (nobody
 * sends), or a wake of the resting sandbox on the next message.
 */
export type ChatSandboxComposer =
  | { readonly kind: "ordinary" }
  | { readonly kind: "line" }
  | { readonly kind: "wake"; readonly sandbox: RestingChatSandbox };

export interface ChatSandboxView {
  /** `null`: not a sandbox state to say; the surface keeps its own path. */
  readonly line: ChatSandboxLine | null;
  readonly composer: ChatSandboxComposer;
}

/** What the viewer may do with the chat, beside what the sandbox is. */
export interface ChatSandboxViewer {
  /** Whether the host answers this device right now. */
  readonly reachable: boolean;
  readonly canEdit: boolean;
  readonly ownedByViewer: boolean;
  readonly environmentOwned: boolean;
  /**
   * Whether a line may promise this chat stays readable: until its read
   * settles on no copy, on a surface that reads the chat. A surface with no
   * read of its own has nothing to prove it by.
   */
  readonly staysReadable: boolean;
}

const ORDINARY: ChatSandboxView = {
  line: null,
  composer: { kind: "ordinary" },
};

/**
 * The one resolver every chat surface consults for a sandbox chat: exactly
 * one line, or none, and one composer mode. The role changes only what the
 * composer may do, never which line shows.
 */
export function resolveChatSandbox(
  state: ChatSandboxState,
  viewer: ChatSandboxViewer,
): ChatSandboxView {
  switch (state.kind) {
    case "none":
      return ORDINARY;
    case "pending":
      // A host that answers is serving the chat; its own path speaks.
      return viewer.reachable
        ? ORDINARY
        : slotLine(state, unknownSandboxLine(state.name, viewer.staysReadable));
    case "moving":
      return slotLine(state, movingSandboxLine(state));
    case "failed":
      return slotLine(state, sandboxFailedChatLine(state.sandbox));
    case "released":
      return slotLine(
        state,
        sandboxReleasedChatLine(state.sandbox.displayName),
      );
    case "destroyed":
      return slotLine(
        state,
        taskSandboxEndLine(
          state.ended.name,
          state.ended.end,
          viewer.staysReadable,
        ),
      );
    case "resting":
      return restingView(state, viewer);
    case "unreachable":
      return {
        line: {
          place: "footer",
          text: `${state.sandbox.displayName} is running, but Traycer can’t connect`,
          state,
        },
        composer: { kind: "ordinary" },
      };
  }
}

function slotLine(state: ChatSandboxState, text: string): ChatSandboxView {
  return { line: { place: "slot", text, state }, composer: { kind: "line" } };
}

/**
 * Until the configuration it bills under resolves, a resting sandbox says its
 * state alone and nobody sends: no promise, no money, no wake with no payer.
 */
function restingView(
  state: Extract<ChatSandboxState, { readonly kind: "resting" }>,
  viewer: ChatSandboxViewer,
): ChatSandboxView {
  const text = `${state.sandbox.displayName} is ${state.sandbox.state === "stopped" ? "stopped" : "suspended"}`;
  const { configuration } = state;
  if (configuration === null) return slotLine(state, text);
  const known: RestingChatSandbox = { ...state, configuration };
  const wakes =
    viewer.canEdit && (viewer.ownedByViewer || viewer.environmentOwned);
  return {
    line: { place: "footer", text, state: known },
    composer: wakes ? { kind: "wake", sandbox: known } : { kind: "ordinary" },
  };
}

/** The sandbox the next message wakes, or `undefined`. */
export function wakeOf(view: ChatSandboxView): RestingChatSandbox | undefined {
  return view.composer.kind === "wake" ? view.composer.sandbox : undefined;
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
function unknownSandboxLine(name: string, staysReadable: boolean): string {
  return staysReadable
    ? `${name} isn't available — this chat stays readable.`
    : `${name} isn't available.`;
}

/** A moving sandbox's line, as its row and setup line say it. */
function movingSandboxLine(
  state: Extract<ChatSandboxState, { readonly kind: "moving" }>,
): string {
  return `${MOVING_VERB[state.state]} ${state.sandbox.displayName} · pending`;
}
