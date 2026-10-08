import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type {
  SandboxLifecycleVerb,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";

/**
 * The sandbox card's per-state copy and actions, kept free of React so the
 * table is read (and tested) in one place. Copy follows the core flows'
 * "what each state means to the user" table; actions are the verbs the
 * control plane accepts from that state (adapter plan, state machine).
 */

/** An action the card offers. `destroy` always asks for confirmation. */
export type SandboxCardAction =
  | "suspend"
  | "resume"
  | "stop"
  | "start"
  | "destroy";

const NO_ACTIONS: readonly SandboxCardAction[] = [];
const FROZEN_ACTIONS: readonly SandboxCardAction[] = ["destroy"];

/**
 * What the card offers from each state. Transitional states offer nothing:
 * the control plane refuses a verb on a row that is moving, and the card
 * re-reads the row as it lands. A frozen row offers only destroy, from every
 * state whose own row includes it - a wake would answer `sandbox_frozen`
 * until credits are added, and deleting a frozen sandbox is allowed at any
 * time. That includes `awake`: the meter sets `frozen` first and drives the
 * suspend afterwards, so a row whose freeze-suspend keeps failing at the
 * provider is frozen and awake, and the server destroys it from there.
 */
const ACTIONS_BY_STATE: Record<HostSandboxState, readonly SandboxCardAction[]> =
  {
    creating: NO_ACTIONS,
    awake: ["suspend", "stop", "destroy"],
    suspending: NO_ACTIONS,
    suspended: ["resume", "destroy"],
    resuming: NO_ACTIONS,
    stopping: NO_ACTIONS,
    stopped: ["start", "destroy"],
    starting: NO_ACTIONS,
    destroying: NO_ACTIONS,
    destroyed: NO_ACTIONS,
    failed: ["destroy"],
    // The Automations row at rest; the server destroys it like any row.
    released: ["destroy"],
  };

export function sandboxCardActions(
  state: HostSandboxState | null,
  frozen: boolean,
): readonly SandboxCardAction[] {
  if (state === null) return NO_ACTIONS;
  const actions = ACTIONS_BY_STATE[state];
  if (frozen) {
    return actions.includes("destroy") ? FROZEN_ACTIONS : NO_ACTIONS;
  }
  return actions;
}

/** The label each action's button carries. */
export const SANDBOX_CARD_ACTION_LABEL: Record<SandboxCardAction, string> = {
  suspend: "Suspend",
  resume: "Resume",
  stop: "Stop",
  start: "Start",
  destroy: "Destroy",
};

const STATE_LINE: Record<HostSandboxState, string> = {
  creating:
    "Provisioning and booting. This takes about 10 seconds once capacity is found.",
  awake: "Running. Billed at the awake rate.",
  suspending: "Suspending. Saving its state; billing moves to storage.",
  suspended:
    "Suspended, resumes on your next action. Billed at the storage rate.",
  resuming: "Resuming. Back in a few seconds.",
  stopping: "Stopping. Its disk is kept; running processes end.",
  stopped:
    "Stopped. Disk kept, processes ended. Start boots it again; shells marked relaunch-on-restart come back.",
  starting: "Starting. Booting from its disk.",
  destroying: "Destroying. Its disk is being deleted.",
  destroyed: "Destroyed. Its disk is gone and nothing more is billed.",
  failed: "Failed to start. Nothing is billed for a sandbox that never woke.",
  released: "Released, disk kept. It comes back on the next shell.",
};

/** "Nov 7, 2026". */
export function formatSandboxDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The frozen banner's sentence. The destroy date shows only when the server
 * says when the row froze (`frozenAt`); a server from before that field gets
 * the sentence without it.
 */
export function sandboxFrozenLine(frozenAt: number | null): string {
  const base = "Frozen: out of credits. Top up to resume.";
  return frozenAt === null
    ? base
    : `${base} Destroyed on ${formatSandboxDay(frozenDestroyAt(frozenAt))}.`;
}

/** The card's one-line description of where the sandbox is. */
export function sandboxStateLine(
  state: HostSandboxState | null,
  frozen: boolean,
  summary: SandboxSummary | null,
): string {
  if (frozen) return sandboxFrozenLine(summary?.frozenAt ?? null);
  if (state === null) return "Sandbox";
  if (state === "failed" && summary !== null && summary.failureCode !== null) {
    return `Failed to start (${summary.failureCode}). Nothing is billed for a sandbox that never woke.`;
  }
  return STATE_LINE[state];
}

/** The idle period the control plane applies when a row sets none. */
export const SANDBOX_DEFAULT_IDLE_MINUTES = 30;

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}

/**
 * The idle rule as the card states it. A burst sandbox is destroyed, not
 * suspended, once idle for its period (core flows, flow 2).
 */
export function sandboxIdleLine(summary: SandboxSummary): string {
  const minutes = summary.idleMinutes ?? SANDBOX_DEFAULT_IDLE_MINUTES;
  return summary.burst
    ? `Destroyed after ${formatMinutes(minutes)} idle`
    : `Suspends after ${formatMinutes(minutes)} idle`;
}

/**
 * What a suspend keeps on this sandbox's provider (core flows, flows 1 and
 * 4), from the catalogue's `suspendFidelity`, or `null` for a value this
 * build does not know.
 */
export function sandboxSuspendKeepsLine(
  suspendFidelity: string,
): string | null {
  switch (suspendFidelity) {
    case "memory":
      return "Suspend keeps memory: processes are still running on resume";
    case "disk":
      return "Suspend keeps the disk only: processes restart on resume";
    case "none":
      return "Suspend keeps nothing: it restarts from its image";
    default:
      return null;
  }
}

/**
 * The guest configuration failure the heartbeat reported, or `null` when the
 * guest is configured or has not reported. The reason is guest-authored
 * text: the card renders it as plain text only.
 */
export function sandboxGuestConfigFailure(
  summary: SandboxSummary,
): string | null {
  if (summary.guestConfigured !== false) return null;
  const reason = summary.guestConfigFailureReason;
  return reason === null || reason.trim().length === 0
    ? "Guest setup failed. Agents can't start here until it succeeds."
    : `Guest setup failed: ${reason}`;
}

/**
 * What a tab on a sandbox host shows over its last screen while the sandbox
 * is not awake (core flows, "what a tab on it shows"), or `null` for a tab
 * that renders normally.
 */
export type SandboxTileOverlay =
  | { readonly kind: "frozen" }
  | {
      readonly kind: "asleep";
      readonly message: string;
      readonly verb: SandboxLifecycleVerb;
      readonly label: string;
    }
  | { readonly kind: "moving"; readonly message: string };

export function sandboxTileOverlay(
  state: HostSandboxState | null,
  frozen: boolean,
): SandboxTileOverlay | null {
  if (frozen) return { kind: "frozen" };
  switch (state) {
    case "suspending":
    case "suspended":
      return {
        kind: "asleep",
        message: "Suspended, resumes on your next action",
        verb: "resume",
        label: "Resume",
      };
    case "stopping":
    case "stopped":
      return {
        kind: "asleep",
        message: "Stopped",
        verb: "start",
        label: "Start",
      };
    case "resuming":
      return { kind: "moving", message: "Resuming" };
    case "starting":
      return { kind: "moving", message: "Starting" };
    // Awake renders normally; creating, failed, destroyed and released are
    // the tile's own connection states, which it already shows.
    case "creating":
    case "awake":
    case "destroying":
    case "destroyed":
    case "failed":
    case "released":
    case null:
      return null;
  }
}
