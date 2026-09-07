import type { HostActivationState } from "./host-state";
import type {
  HostUpdateAttemptContinuation,
  HostUpdateAttemptPhase,
} from "@traycer/protocol/config/host-update-attempt";

// Type surface for `HostController` (Host Update Layer Redesign Tech Plan,
// "Desktop main: HostController" > "State model" / "Canonical status").

export type MutationKind =
  | "ensure"
  | "apply"
  | "activate"
  | "install"
  | "register"
  | "deregister"
  | "respawn"
  | "recoverIfDown"
  | "freePortAndRestart"
  | "uninstallHost"
  | "removeTraycer";

export interface MutationProgress {
  readonly stage: string | null;
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
  readonly message: string | null;
  /** ⚠ Producers increment it only when a unit of work has COMPLETED, never on a timer. */
  readonly workUnits: number | null;
}

export interface MutationLaneStatus {
  readonly kind: MutationKind;
  readonly progress: MutationProgress | null;
  readonly startedAt: string;
}

export type LifecycleAdmissionBlock =
  | { readonly kind: "mutation"; readonly lane: MutationLaneStatus }
  | { readonly kind: "login-item-refresh" };

/** The cycle's reverse admission (defer while the mutation lane owns an intent) applies to an OUTSIDE caller only: `convergeReady` reaches the cycle from inside its own lane job. */
export type PendingRevisionCaller = "outside-lane" | "within-lane-job";

export interface DownloadProgress {
  readonly percent: number | null;
  readonly bytes: number | null;
  readonly totalBytes: number | null;
}

export interface DownloadLaneStatus {
  readonly version: string;
  readonly progress: DownloadProgress | null;
  readonly lastError: string | null;
}

export interface LocalAttemptFacts {
  readonly attemptId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly targetVersion: string;
  readonly phase: HostUpdateAttemptPhase;
  // `HostUpdateAttemptContinuation` already includes `null`.
  readonly continuation: HostUpdateAttemptContinuation;
  readonly updatedAt: string;
}

// Two independent lanes, per the Tech Plan's canonical status shape.
export interface HostControllerStatus {
  /** Durable attempt facts for the host-down window (Ticket 07 §5.2.7). */
  readonly localAttempt: LocalAttemptFacts | null;
  readonly download: DownloadLaneStatus | null;
  readonly mutation: MutationLaneStatus | null;
  readonly installedVersion: string | null;
  readonly latestVersion: string | null;
  readonly stagedVersion: string | null;
  readonly installedRuntimeVersion: string | null;
  readonly runningRuntimeVersion: string | null;
  readonly updateReady: boolean;
  readonly activation: HostActivationState;
  readonly reachable: boolean;
  readonly removedByUser: boolean;
  readonly checkedAt: string;
}

// Post-commit busy (packaged macOS, bytes already committed): `"activate"` - Force submits `activateInstalled{force}`, never a retry of the consumed apply/pin.
export type BusyContinuation = "retry-with-force" | "activate";

// The automatic recovery classifier (`respawnIfDown`) matches on this exact message to treat the deferral as terminal, so emit sites and the matcher must share one definition rather.
export const HOST_REMOVED_BY_USER_MESSAGE = "Host was removed by the user.";

// The removal sentinel MEANS something to them: a removed host must stay removed, so `convergeReady` short-circuits on it.
// That IS an explicit request to have the host back, so the sentinel must be cleared rather than obeyed.
export type LocalHostMutationIntent =
  | { readonly kind: "background" }
  | {
      readonly kind: "user-repair";
      readonly targetHostId: string;
      readonly guard: () => Promise<ReprovisionGuardVerdict>;
    };

export type ReprovisionGuardVerdict =
  | { readonly kind: "proceed" }
  | { readonly kind: "abandon"; readonly message: string };

// Per-intent result. Every mutation intent resolves ONE of these - the
// lane itself never rejects ("wait-never-reject"); a busy/deferred/failed
// outcome is a normal resolved value the calling surface renders.
export type MutationOutcome<TOk> =
  | { readonly kind: "ok"; readonly value: TOk }
  | {
      readonly kind: "busy";
      readonly continuation: BusyContinuation;
      readonly message: string;
    }
  | { readonly kind: "deferred"; readonly message: string }
  | { readonly kind: "stage-fingerprint-mismatch"; readonly message: string }
  // This must not masquerade as an ordinary successful apply: callers surface recovery rather than an update-ready state.
  | { readonly kind: "installed-not-converged"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

// When two windows submit the same repair for the same host, the second submission JOINS the first's promise and its own intent never runs.
// - No unguarded mutation can produce it, so putting it in `MutationOutcome` would force every switch over that union - including the renderer's.
export interface AbandonedByGuard {
  readonly kind: "abandoned";
  readonly message: string;
}

/** What an intent-taking (guardable) mutation resolves. */
export type GuardedMutationOutcome<TOk> =
  | MutationOutcome<TOk>
  | AbandonedByGuard;

/**
 * Narrows a guarded outcome for a caller that submitted a `background` intent.
 * A background intent carries no guard, so `abandoned` cannot occur on that path.
 */
export function backgroundMutationOutcome<TOk>(
  outcome: GuardedMutationOutcome<TOk>,
): MutationOutcome<TOk> {
  return outcome.kind === "abandoned"
    ? { kind: "failed", message: outcome.message }
    : outcome;
}

export interface ConvergeReadyOk {
  readonly running: boolean;
  readonly version: string | null;
}

export interface ApplyStagedOk {
  readonly appliedVersion: string;
  readonly runningActivated: boolean;
}

export interface ActivateInstalledOk {
  readonly activated: boolean;
}

export interface InstallVersionOk {
  readonly installedVersion: string;
  readonly runningActivated: boolean;
}

export interface ServiceRegistrationOk {
  readonly registered: boolean;
}

export interface UninstallOk {
  readonly removedInstallDir: boolean;
  readonly deregisteredService: boolean;
  readonly serviceRegistrationRetained: boolean | null;
}

export interface RemoveTraycerOk {
  readonly removedHost: boolean;
  /** Same weaker meaning as `UninstallOk.deregisteredService` - see there. */
  readonly deregisteredService: boolean;
  /** Carried here too: discarding it left Remove Traycer publishing the weakened boolean as an accomplished fact with no way for a caller to see the uncertainty. */
  readonly serviceRegistrationRetained: boolean | null;
  readonly removedLoginItem: boolean;
}

export type ApplyStagedTrigger = "launch" | "manual";

export type HostControllerIntent =
  | { readonly type: "convergeReady"; readonly force: boolean }
  | { readonly type: "stageLatest" }
  | {
      readonly type: "applyStaged";
      readonly trigger: ApplyStagedTrigger;
      readonly force: boolean;
    }
  | { readonly type: "activateInstalled"; readonly force: boolean }
  | {
      readonly type: "installVersion";
      readonly pin: string;
      readonly force: boolean;
    }
  | { readonly type: "registerService" }
  | { readonly type: "deregisterService" }
  | { readonly type: "respawn" }
  | { readonly type: "recoverIfDown" }
  | {
      readonly type: "freePortAndRestart";
      readonly pid: number | null;
      readonly port: number | null;
    }
  | { readonly type: "uninstallHost"; readonly all: boolean }
  | { readonly type: "removeTraycer" };
