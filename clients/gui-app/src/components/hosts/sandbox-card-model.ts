import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import {
  parseSandboxHeartbeatPhase,
  type SandboxKind,
  type SandboxLifecycleVerb,
  type SandboxMember,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
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
 * re-reads the row as it lands. Except Destroy from `suspending` and
 * `stopping`: a vendor that keeps refusing leaves the row there, and the
 * control plane takes a destroy once one attempt's time is up
 * (`mayEnterDestroying`); before then it answers that the sandbox is
 * changing state. A frozen row offers only destroy, from every
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
    suspending: ["destroy"],
    suspended: ["resume", "destroy"],
    resuming: NO_ACTIONS,
    stopping: ["destroy"],
    stopped: ["start", "destroy"],
    starting: NO_ACTIONS,
    destroying: NO_ACTIONS,
    destroyed: NO_ACTIONS,
    failed: ["destroy"],
    // Only the Automations row rests here; see its own table below.
    released: ["destroy"],
  };

/**
 * The Automations row's verbs (`kind: "automation"`): it is `released` or
 * `awake`, never suspended. `stop` releases it (scaled to zero, disk kept),
 * `start` opens it, and a suspend would answer `409`, so it is never offered.
 * The server destroys it like any row.
 */
const AUTOMATION_ACTIONS_BY_STATE: Record<
  HostSandboxState,
  readonly SandboxCardAction[]
> = {
  ...ACTIONS_BY_STATE,
  awake: ["stop", "destroy"],
  released: ["start", "destroy"],
};

export function sandboxCardActions(
  state: HostSandboxState | null,
  frozen: boolean,
  kind: SandboxKind,
): readonly SandboxCardAction[] {
  if (state === null) return NO_ACTIONS;
  const actions =
    kind === "automation"
      ? AUTOMATION_ACTIONS_BY_STATE[state]
      : ACTIONS_BY_STATE[state];
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

/**
 * Who made a team sandbox, or `null` when the server does not
 * say (a personal sandbox, or a server before the field).
 */
export function sandboxCreatorLine(
  summary: SandboxSummary,
  viewerUserId: string | null,
): string | null {
  const creator = summary.createdBy;
  if (creator === null) return null;
  return `Created by ${memberWords(creator, viewerUserId, CREATOR_WORDS)}`;
}

/**
 * Whose bundle the running wake of a team sandbox is charged to, while it is
 * awake; `null` asleep, frozen, or when the server names no payer.
 */
export function sandboxWakePayerLine(
  state: HostSandboxState | null,
  frozen: boolean,
  summary: SandboxSummary,
  viewerUserId: string | null,
): string | null {
  const payer = summary.wakePayer;
  if (state !== "awake" || frozen || payer === null) return null;
  return `This wake is on ${memberWords(payer, viewerUserId, PAYER_WORDS)} bundle`;
}

/** A frozen team sandbox: the paying member's bundle ran out. */
export function sandboxTeamFrozenLine(
  summary: SandboxSummary,
  viewerUserId: string | null,
): string {
  const payer = summary.wakePayer;
  if (payer === null) return "Frozen: its payer's bundle is out.";
  if (viewerUserId !== null && payer.userId === viewerUserId) {
    return "Frozen: your bundle is out.";
  }
  return payer.displayName === null
    ? "Frozen: its payer's bundle is out."
    : `Frozen: ${payer.displayName}'s bundle is out.`;
}

/**
 * A frozen team sandbox's state line: whose bundle is out, then the destroy
 * date when the server sends `frozenAt`, as the personal line has it. Before
 * the sandbox list answers (`summary` null) it names no one, and still never
 * says "your credits".
 */
export function sandboxTeamFrozenStateLine(
  summary: SandboxSummary | null,
  viewerUserId: string | null,
): string {
  if (summary === null) return "Frozen: its payer's bundle is out.";
  const line = sandboxTeamFrozenLine(summary, viewerUserId);
  return summary.frozenAt === null
    ? line
    : `${line} Destroyed on ${formatSandboxDay(frozenDestroyAt(summary.frozenAt))}.`;
}

/** A team pod's room, from the pod list's `headroom` and `liveShells`. */
export function sandboxPodRoomLine(
  headroom: number,
  liveShells: number,
): string {
  const room =
    headroom === 0
      ? "No room for another shell"
      : `Room for ${headroom} more ${headroom === 1 ? "shell" : "shells"}`;
  const live =
    liveShells === 0
      ? "no live shells"
      : `${liveShells} live ${liveShells === 1 ? "shell" : "shells"}`;
  return `${room} · ${live}`;
}

/**
 * Whether the card mounts the personal cost view. The cost read lists only
 * the person's own sandboxes, so a team card (pods included) has no entry in
 * it; its payer line says whose bundle the wake is on instead.
 */
export function sandboxCardShowsCostView(teamOwned: boolean): boolean {
  return !teamOwned;
}

/** How a line names a member: the viewer, a named member, an unnamed one. */
interface MemberWords {
  readonly viewer: string;
  readonly named: (displayName: string) => string;
  readonly unnamed: string;
}

const CREATOR_WORDS: MemberWords = {
  viewer: "you",
  named: (displayName) => displayName,
  unnamed: "a team member",
};

const PAYER_WORDS: MemberWords = {
  viewer: "your",
  named: (displayName) => `${displayName}'s`,
  unnamed: "a team member's",
};

function memberWords(
  member: SandboxMember,
  viewerUserId: string | null,
  words: MemberWords,
): string {
  if (viewerUserId !== null && member.userId === viewerUserId) {
    return words.viewer;
  }
  return member.displayName === null
    ? words.unnamed
    : words.named(member.displayName);
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
  // The Automations row is never metered.
  if (state === "awake" && summary?.kind === "automation") {
    return "Running. Automations aren't billed.";
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
 * suspended, once idle for its period (core flows, flow 2); the Automations
 * row is released.
 */
export function sandboxIdleLine(summary: SandboxSummary): string {
  // The control plane's release job, not the row's idle period: a day with no
  // shell on it (`AUTOMATION_RELEASE_AFTER_MS`).
  if (summary.kind === "automation")
    return "Released after a day with no shell";
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
 * Whether brokered traffic flows on an awake sandbox, from the phase its host
 * last reported (`SandboxSummary.phase`). The card says "ready" on this and
 * not on the host merely being up: a sandbox whose host answers while its
 * gateway connection is still being proven cannot use a single secret yet.
 */
export interface SandboxSecretsReadiness {
  readonly tone: "ready" | "pending" | "degraded";
  readonly text: string;
}

/**
 * Whether what the sandbox's host last reported (its phase, its per-route
 * readiness) can still be shown. Nothing ages those reports: an idle
 * sandbox's host reports nothing, by design. So they stand only while the
 * host's own health - the verdict the host switcher shows - says it is
 * reachable; a host that went offline says nothing rather than a state it can
 * no longer vouch for. `reported-reachable` keeps them: it is the healthy
 * reading of a host this window never dialled.
 */
export function sandboxHostVouches(hostState: HostHealthState): boolean {
  return hostState === "online" || hostState === "reported-reachable";
}

/** The longest hop name shown; the phase is the guest's own text. */
const DEGRADED_HOP_MAX_LENGTH = 80;

/**
 * `null` when there is nothing to say: the sandbox is not awake (its grants
 * are refused until it is, and the state line already says where it stands),
 * its host is not reachable, the server reports no phase (one from before the
 * field, or a sandbox with no brokered secrets), or the phase is one this
 * build does not know - which is shown as nothing, never as ready.
 *
 * The phase is the one the host LAST reported, so the line stands only while
 * `sandboxHostVouches(hostState)`.
 */
export function sandboxSecretsReadiness(
  state: HostSandboxState | null,
  frozen: boolean,
  summary: SandboxSummary,
  hostState: HostHealthState,
): SandboxSecretsReadiness | null {
  if (frozen || state !== "awake" || summary.phase === null) return null;
  if (!sandboxHostVouches(hostState)) return null;
  const phase = parseSandboxHeartbeatPhase(summary.phase);
  switch (phase.kind) {
    case "proxy-reachable":
    case "ready":
      return { tone: "ready", text: "Ready: brokered traffic is flowing" };
    case "enrolling":
    case "proving":
    case "attaching":
      return {
        tone: "pending",
        text: "Connecting to Traycer's gateway. Secrets work once it is ready.",
      };
    case "degraded": {
      const hop = phase.hop.trim().slice(0, DEGRADED_HOP_MAX_LENGTH);
      return {
        tone: "degraded",
        text:
          hop.length === 0
            ? "Degraded: requests to granted destinations are refused until it recovers."
            : `Degraded at ${hop}: requests to granted destinations are refused until it recovers.`,
      };
    }
    case "unknown":
      return null;
  }
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
    // The Automations row at rest: `start` opens it.
    case "released":
      return {
        kind: "asleep",
        message: "Released",
        verb: "start",
        label: "Start",
      };
    case "resuming":
      return { kind: "moving", message: "Resuming" };
    case "starting":
      return { kind: "moving", message: "Starting" };
    // Awake renders normally; creating, failed and destroyed are the tile's
    // own connection states, which it already shows.
    case "creating":
    case "awake":
    case "destroying":
    case "destroyed":
    case "failed":
    case null:
      return null;
  }
}
