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

/**
 * Mirror of `@traycer-clients/shared`'s `LocalAttemptFacts`.
 *
 * This file already re-declares `HostControllerStatus` structurally rather than
 * importing it, and this rides that existing shape. The duplication is
 * pre-existing and out of Ticket 07's scope; noting it so the next reader knows
 * BOTH declarations must move together, and that the compile is what catches a
 * one-sided edit.
 */
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

// Who asked for a local-host mutation. Three methods take it -
// `convergeReady`, `registerService` and `freePortAndRestart` - and they use
// DIFFERENT halves of it, which is the distinction the name has to carry:
//
//   - all three run `guard` at the head of the lane;
//   - only the two REPROVISION methods also clear the removal sentinel.
//     Free-port-and-restart is a restart, not a reprovision, so it keeps the
//     removed-by-user deferral exactly as a plain restart does.
//
// `convergeReady` and `registerService` serve two callers with genuinely
// different contracts, and conflating them is what let "Install host" report
// success having installed nothing:
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
export type LocalHostMutationIntent =
  | { readonly kind: "background" }
  | {
      readonly kind: "user-repair";
      /**
       * The host this repair was asked FOR. Part of the coalesce key, not
       * decoration: two repairs are the same job only if they target the same
       * host. Keyed on the intent KIND alone, a repair for replacement host B
       * would join host A's in-flight promise, inherit A's guard, and be
       * refused for the crime of being B - a correct request rejected by
       * another request's identity check.
       */
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

// The lane-head identity guard refused a `user-repair` intent: the local host
// is no longer the one the repair named, so the job mutated NOTHING.
//
// A distinct arm rather than `failed`, and a widening of the intent-taking
// methods' return union rather than of `MutationOutcome` itself:
//
//   - Coalesced waiters share ONE settled outcome. When two windows submit
//     the same repair for the same host, the second submission JOINS the
//     first's promise and its own intent never runs - so any per-caller
//     state (a closure the guard arms) is dead for the joiner, which would
//     misread the shared `failed` as a genuine error and count it toward the
//     Doctor console's recurrence lock. The classification has to travel IN
//     the outcome every waiter receives.
//   - No unguarded mutation can produce it, so putting it in
//     `MutationOutcome` would force every switch over that union - including
//     the renderer's - to handle an arm that cannot occur there. The IPC
//     handlers that supply guards classify it into their own result shapes;
//     it never crosses the wire.
export interface AbandonedByGuard {
  readonly kind: "abandoned";
  readonly message: string;
}

/** What an intent-taking (guardable) mutation resolves. */
export type GuardedMutationOutcome<TOk> =
  | MutationOutcome<TOk>
  | AbandonedByGuard;

/**
 * Narrows a guarded outcome for a caller that submitted a `background`
 * intent. A background intent carries no guard, so `abandoned` cannot occur
 * on that path; mapping it to `failed` rather than asserting it away keeps
 * the caller total if the invariant ever breaks.
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
  /**
   * The deregistration was PERFORMED and nothing contradicted it - not that
   * the registration is provably gone.
   *
   * That weaker meaning is the only honest one available. No platform can
   * verify absence: Windows maps every `schtasks /Query` failure (timeout,
   * access denial) to `not-installed`, Linux re-reads the manifest the
   * uninstall just deleted, and macOS's `launchctl print` probe tolerates
   * non-zero while an unloaded SMAppService record is invisible to it. A field
   * meaning "actually accomplished" would therefore be unsatisfiable, so the
   * contract is stated rather than the value inverted.
   *
   * It IS false when the CLI's readback positively found the registration
   * still present - a positive observation is real evidence and vetoes the
   * claim. Read `serviceRegistrationRetained` for the underlying tri-state.
   */
  readonly deregisteredService: boolean;
  /**
   * What the CLI's post-teardown readback actually observed.
   * `true` = definitely still registered, `null` = nothing could confirm
   * either way, `false` = verified absent (no platform produces this today).
   */
  readonly serviceRegistrationRetained: boolean | null;
}

export interface RemoveTraycerOk {
  readonly removedHost: boolean;
  /** Same weaker meaning as `UninstallOk.deregisteredService` - see there. */
  readonly deregisteredService: boolean;
  /**
   * Same tri-state as `UninstallOk.serviceRegistrationRetained`. Carried here
   * too: discarding it left Remove Traycer publishing the weakened boolean as
   * an accomplished fact with no way for a caller to see the uncertainty.
   */
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
