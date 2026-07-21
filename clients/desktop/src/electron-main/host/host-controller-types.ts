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
}

export interface MutationLaneStatus {
  readonly kind: MutationKind;
  readonly progress: MutationProgress | null;
  readonly startedAt: string;
}

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
