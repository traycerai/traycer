import type { HostActivationState } from "./host-state";

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
  /**
   * Monotonic count of discrete units of work completed within this stage -
   * the CLI's `ProgressInfo.workUnits`, forwarded unchanged.
   *
   * ⚠ Producers increment it only when a unit of work has COMPLETED, never on a
   * timer. The renderer's staged wait reads it to tell an advancing stage from a
   * stalled one, so a timer-driven producer would report a wedged install as
   * healthy.
   *
   * `null` from any producer with no discrete unit to count, and from any CLI
   * predating the field - `parseNdjsonEvent` normalises an absent numeric to
   * `null`, so an older bundled CLI degrades to the pre-field behaviour.
   */
  readonly workUnits: number | null;
}

export interface MutationLaneStatus {
  readonly kind: MutationKind;
  readonly progress: MutationProgress | null;
  readonly startedAt: string;
}

/**
 * Why an admission-checked lifecycle write would not run alone right now.
 * `mutation` is the FIFO lane's running intent; `login-item-refresh` is the
 * pending-login-item revision cycle, which runs on its own tail (it cannot
 * take FIFO exclusivity — see `pendingRevisionTail` in `host-controller.ts`)
 * but restarts the host exactly like a lane job would.
 */
export type LifecycleAdmissionBlock =
  | { readonly kind: "mutation"; readonly lane: MutationLaneStatus }
  | { readonly kind: "login-item-refresh" };

/**
 * Who is asking the pending-login-item revision cycle to run. The cycle's
 * reverse admission (defer while the mutation lane owns an intent) applies to
 * an OUTSIDE caller only: `convergeReady` reaches the cycle from inside its
 * own lane job, where the occupied lane IS the caller, not a competitor.
 */
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

// Two independent lanes, per the Tech Plan's canonical status shape.
export interface HostControllerStatus {
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

// ---- Continuations ----------------------------------------------------
//
// Pre-commit busy (CLI-owned apply/pin refused before the stop):
// `"retry-with-force"` - Force re-submits the same intent with `force`.
// Post-commit busy (packaged macOS, bytes already committed):
// `"activate"` - Force submits `activateInstalled{force}`, never a retry
// of the consumed apply/pin.
export type BusyContinuation = "retry-with-force" | "activate";

// Emitted verbatim by every removed-by-user deferred outcome. The automatic
// recovery classifier (`respawnIfDown`) matches on this exact message to
// treat the deferral as terminal, so emit sites and the matcher must share
// one definition rather than risk wording drift.
export const HOST_REMOVED_BY_USER_MESSAGE = "Host was removed by the user.";

// Why a (re)provision was asked for. `convergeReady` and `registerService`
// serve two callers with genuinely different contracts, and conflating them
// is what let "Install host" report success having installed nothing:
//
//   - `background` is the reconciler, launch convergence and selection
//     ports. The removal sentinel MEANS something to them: a removed host
//     must stay removed, so `convergeReady` short-circuits on it.
//   - `user-repair` is a person clicking Install host or Register service in
//     Doctor. That IS an explicit request to have the host back, so the
//     sentinel must be cleared rather than obeyed - the same contract
//     `installVersion` has always had, applied to its two siblings.
//
// `guard` runs at the HEAD of the lane, not at the call site. A repair can
// wait minutes behind an install, and the host it was aimed at can be
// replaced or re-enrolled in that window; a check performed before
// enqueueing proves nothing about the host the job will actually mutate.
// The IPC layer owns identity policy and supplies it as this closure, so the
// controller decides only WHEN the question is asked.
export type ReprovisionIntent =
  | { readonly kind: "background" }
  | {
      readonly kind: "user-repair";
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
  // Lock-contention terminal contract (bounded CLI_LOCK_BUSY retry
  // exhausted): manual intents resolve this "deferred - another Traycer
  // process is managing the host" outcome, rendered by whichever surface
  // invoked them.
  | { readonly kind: "deferred"; readonly message: string }
  | { readonly kind: "stage-fingerprint-mismatch"; readonly message: string }
  // The install bytes committed, but Desktop could not establish the
  // post-commit service/readiness invariant. This must not masquerade as an
  // ordinary successful apply: callers surface recovery rather than an
  // update-ready state.
  | { readonly kind: "installed-not-converged"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

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
}

export interface RemoveTraycerOk {
  readonly removedHost: boolean;
  readonly deregisteredService: boolean;
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
