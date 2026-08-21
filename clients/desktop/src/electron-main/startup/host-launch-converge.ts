import { log } from "../app/logger";
import { refreshRegistryUpdateState } from "../ipc/host-management-ipc";
import { isHostRemovedByUser } from "../host/host-removal-state";
import {
  backgroundMutationOutcome,
  type ActivateInstalledOk,
  type ApplyStagedOk,
  type ConvergeReadyOk,
  type HostControllerStatus,
  type MutationOutcome,
} from "../host/host-controller-types";
import type { HostActivationState } from "../host/host-state";
import type { IpcHostController } from "../ipc/runner-ipc-bridge";

// Narrowed to the one method this module actually drives - declared here
// (not imported from `menu-controller.ts`) so tests can pass a lightweight
// double instead of constructing the real `MenuController`, the same "narrow
// interface for testability" pattern `IpcHostController` uses for
// `HostController`. The real `MenuController` satisfies this structurally.
/**
 * Whether an account is signed in, and a way to hear when that changes.
 *
 * Narrow on purpose: {@link armLocalHostBootOnSignIn} needs consent, not
 * identity. Main already has this fact - the selection authority's
 * `DesktopAuthorityIdentitySource` is built from the same `authSession` - and
 * declaring the shape here keeps this module from importing the authority to
 * ask one boolean.
 */
export interface SignedInGate {
  isSignedIn(): boolean;
  /** Returns an unsubscribe. */
  onChanged(listener: (signedIn: boolean) => void): () => void;
}

/** The production {@link SignedInGate}, over main's own auth session. */
export function signedInGateFromAuthSession(session: {
  get(): { readonly status: string };
  on(event: "change", listener: () => void): void;
  off(event: "change", listener: () => void): void;
}): SignedInGate {
  const isSignedIn = (): boolean => session.get().status === "signed-in";
  return {
    isSignedIn,
    onChanged: (listener) => {
      const forward = (): void => {
        listener(isSignedIn());
      };
      session.on("change", forward);
      return () => {
        session.off("change", forward);
      };
    },
  };
}

export interface HostUpdateMenuSurface {
  setHostUpdateAvailableVersion(version: string | null): void;
}

const ACTIVATION_DEBT_STATES: ReadonlySet<HostActivationState> = new Set([
  "pendingActivation",
  "activationUnknown",
]);

// The one predicate every recovery arm gates on, in both halves:
// `activation: "unavailable"` describes the RUNNING runtime only, so an
// absent service is a repair target ONLY under a host that is genuinely
// installed - a fresh machine that has never installed one reports the same
// activation state, and recovering there would provision and start a
// background host before the user has signed in, bypassing the renderer's
// `authStatus === "signed-in"` provisioning gate. Named once so a future
// activation state or an extra condition cannot land in one arm and not the
// others.
function isUnavailableInstalledHost(status: HostControllerStatus): boolean {
  return (
    status.activation === "unavailable" && status.installedVersion !== null
  );
}

// "Update to X" gates on `updateReady` OR activation debt (Renderer
// surfaces cutover ticket, D4/D5): a ready update supersedes debt (its own
// version is the label); debt alone labels the already-installed version,
// since activating it is the available action - never the same intent as
// applying a newer stage. `null` (up to date, no debt, or `activation:
// "unavailable"` - that's the gate's domain, never a menu affordance) hides
// the row entirely.
export function deriveHostUpdateMenuVersion(
  status: HostControllerStatus,
): string | null {
  if (status.updateReady) {
    return status.stagedVersion;
  }
  if (ACTIVATION_DEBT_STATES.has(status.activation)) {
    return status.installedVersion;
  }
  return null;
}

// Reflects the host update/activation-debt availability into the app menu's
// "Update to X" affordance. Shared by the launch probe, the periodic/resume
// refreshes, and the launch converge reconcile below so all of them keep the
// menu in lockstep with the canonical two-lane controller status.
export function applyHostUpdateMenuState(
  menu: HostUpdateMenuSurface,
  status: HostControllerStatus,
): void {
  menu.setHostUpdateAvailableVersion(deriveHostUpdateMenuVersion(status));
}

// Shared by the launch probe, the periodic timer, the resume trigger, and the
// launch converge reconcile below. `refreshRegistryUpdateState` never throws
// and is internally serialized (`registryRefreshQueue`), so overlapping calls
// are safe. Narrow params (not `AppServices`) so callers can exercise this
// with lightweight fakes in a test. The registry probe's own result only
// carries version-comparison state (no activation domain), so the menu label
// is derived from a fresh `getStatus()` read taken right after - the probe's
// background `stageLatest()` may have just changed `stagedVersion`.
export async function refreshHostRegistryIfNotRemoved(
  hostController: IpcHostController,
  menu: HostUpdateMenuSurface,
  opts: { readonly force: boolean; readonly maxAgeMs: number | null },
): Promise<void> {
  if (await isHostRemovedByUser()) return;
  await refreshRegistryUpdateState(hostController, opts);
  const status = await hostController.getStatus();
  applyHostUpdateMenuState(menu, status);
}

/**
 * Backoff between attempts of {@link armLocalHostBootOnSignIn} after one that
 * did not end with a running host. Rung 0 matches the selection authority's
 * `LOCAL_ENSURE_RETRY_COOLDOWN_MS`, so the two process actors that can drive
 * `convergeReady` for this machine pace their first retry the same way; the
 * ladder then backs off to a five-minute ceiling and stays there - the retry
 * never stops on its own, because the released desktop's local host was
 * always brought up eventually and the user has ruled that this must not
 * regress. Every attempt is one `host ensure` invocation: for a host whose
 * install keeps failing that is a bounded, mostly-idle process every five
 * minutes, and for a host that is only waiting on the user (macOS "Allow in
 * the Background") the same register cycle the Retry button used to run.
 */
export const LOCAL_HOST_BOOT_RETRY_LADDER_MS: readonly number[] = [
  30_000, 60_000, 120_000, 300_000,
];

/**
 * BOOTING THIS MACHINE'S HOST, and the actor that owns it: install when there
 * has never been one, start when there is one and it is not running, and keep
 * trying - on {@link LOCAL_HOST_BOOT_RETRY_LADDER_MS} - until a host is
 * running. Signed-in gated (below).
 *
 * Deliberately a SIBLING of {@link runLaunchHostConvergeReconcile} rather than
 * an arm inside it. That reconciler's contract is "settle the debt of a host
 * that EXISTS, once, in priority order" - its update, activation and recovery
 * arms are all structurally unable to first-install, by their own predicates:
 * `deriveUpdateReady` returns false outright when `installedVersion` is null,
 * nothing is running so activation reads `"unavailable"` rather than
 * pending/unknown, and `isUnavailableInstalledHost` requires an installed
 * version by definition. Two tests pin that contract, and it stays true. This
 * actor's contract is different in both halves: it does not care WHY there is
 * no running host, and it is not one-shot. Where the two overlap - an
 * installed host that is down at launch - both ask `convergeReady(false)`, and
 * the controller coalesces identical in-flight intents onto one job, so the
 * overlap costs nothing and the reconciler keeps its unavailable-first
 * ordering against the release download.
 *
 * ## Why main performs it at all
 *
 * The RENDERER used to: a once-per-mount `convergeReady` in the local-host
 * gate (deleted in P3.4), with a manual Retry. Redesign P1.3 retired that -
 * correctly, because two process actors for one host is what made the ∅
 * definition undecidable - and moved boot-time provisioning intent to the
 * selection authority. But the authority asks through `LocalHostEnsurePort`
 * keyed on a hostId it reads from the fleet, and the fleet reads the local id
 * from the enrollment and pid-metadata files. Until this machine's host has
 * RUN at least once those files do not exist, the id is null, and
 * `requestLocalEnsureIfDown` returns on its second line. The authority cannot
 * ask for a host that has never existed, so the intent had moved to an actor
 * unable to exercise it in the one case where boot-time provisioning IS the
 * point: a first launch sat on "Starting local Traycer Host…" with nothing
 * starting.
 *
 * The split, stated once: getting a host RUNNING for the first time in a
 * process lifetime here, with retry; steady-state ensure of a host the fleet
 * can name (one that has run) in the authority - whichever host a window is
 * pointed at, since 2026-08-19 (the local lifecycle is target-independent;
 * only its narration is target-scoped). D14/C5's "one sanctioned process
 * action" is untouched - that constraint scopes the AUTHORITY, which still
 * performs exactly one.
 *
 * ## Why it retries on a timer, not only on a sign-in edge
 *
 * A first attempt can fail for reasons that clear on their own - the CLI lock
 * held by another Traycer process (`deferred`), a download that lost the
 * network, a service that took longer than the readiness budget, an IPC round
 * trip that threw - and until 2026-08-19 the only thing that tried again was
 * the next SIGN-IN edge, which for a user who stays signed in is never. The
 * ruling that fixed this: the local host is brought up automatically, and it
 * used to come up without anyone signing in again, so it must keep doing so.
 * Hence the ladder. A settled arm never re-arms; a mid-session death after a
 * successful boot is the authority's, since by then the fleet knows the id.
 *
 * ## Consent is the precondition, and it is not decoration
 *
 * Installing a background service on someone's machine is consent-bearing, and
 * the retired renderer path was SIGN-IN GATED - `computeGateEligibility`
 * passes through for a signed-out user, so the host was only ever installed
 * for someone signed in and looking at a card that said so. Restoring the
 * behaviour without that gate would not be restoring it; it would be the same
 * action under a materially weaker precondition. Hence the wait: signed out at
 * launch means nothing happens until an account actually signs in, which is
 * also the pre-retirement TIMING, since the gate only mounted after sign-in. A
 * sign-out cancels a pending retry the same way, and the next sign-in starts
 * the ladder over from rung 0.
 *
 * `removedByUser` is the other half of consent and is checked at the moment of
 * acting: a user who removed the host has `installedVersion === null` too, and
 * must not have it reinstalled underneath them.
 *
 * Returns a disposer for the subscription and any pending retry. Settles -
 * disposes itself - only once a host is RUNNING (its own `convergeReady` came
 * back `ok`, or a status read shows a live runtime) or the user has removed
 * Traycer. Notably NOT on `busy`: see the outcome branch below.
 */
export function armLocalHostBootOnSignIn(
  hostController: IpcHostController,
  identity: SignedInGate,
): () => void {
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryRung = 0;

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const dispose = (): void => {
    // TERMINAL, and that has to be recorded BEFORE the resources go, because
    // an attempt can be in flight right now. Clearing the timer and the
    // subscription alone leaves `settled` false, so the continuation of an
    // `getStatus()`/`convergeReady()` that resolves after disposal walks into
    // `scheduleRetry()` and arms a fresh timer - a disposed actor that goes on
    // provisioning. Reachable in production since the disposer is registered
    // on the bridge's teardown list: a quit that lands mid-ladder is exactly
    // this race.
    settled = true;
    clearRetry();
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  // Reaching a terminal outcome and being torn down are now the SAME
  // operation. The name is kept because the call sites below mean "this actor
  // is done", not "someone asked it to stop".
  const settle = (): void => {
    dispose();
  };

  const scheduleRetry = (): void => {
    // Consent is re-read for the TIMER, not only for the action: an outcome
    // that lands alongside a sign-out (the falling edge reached the
    // subscription while the converge was in flight) must not leave a retry
    // ticking for an account that left. The sign-in edge is that account's
    // retry, and it starts a fresh ladder.
    if (settled || retryTimer !== null || !identity.isSignedIn()) return;
    const delayMs =
      LOCAL_HOST_BOOT_RETRY_LADDER_MS[
        Math.min(retryRung, LOCAL_HOST_BOOT_RETRY_LADDER_MS.length - 1)
      ];
    retryRung += 1;
    const timer = setTimeout(() => {
      retryTimer = null;
      attempt();
    }, delayMs);
    // The retry ladder must never be what keeps the main process alive.
    timer.unref();
    retryTimer = timer;
    log.info("[host-controller] local host boot retry scheduled", { delayMs });
  };

  let inFlight = false;
  const attempt = (): void => {
    if (settled || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const status = await hostController.getStatus();
        // DISPOSAL RE-READ, and it belongs here for the same reason the
        // consent re-read below does: the decision to act was taken before a
        // round trip, and teardown can land inside it. Recording terminal in
        // `dispose()` stops this continuation from arming another RETRY, but
        // by itself it would let this one still reach `convergeReady` and
        // enqueue a provisioning mutation - a CLI `host ensure` starting
        // against a controller the app is tearing down. The check has to be
        // before the mutation, not only after it.
        if (settled) return;
        if (status.removedByUser) {
          log.info(
            "[host-controller] local host boot skipped for removed host",
          );
          settle();
          return;
        }
        if (status.activation !== "unavailable") {
          // `unavailable` is the one activation state that means NO runtime is
          // running (`deriveActivationState`); every other value is a live
          // host - activated, or carrying activation debt that is the
          // reconciler's to settle, never this actor's. Something brought it
          // up between arming and now (a previous launch that finished late,
          // the reconciler's recovery arm, a user at the terminal), or the
          // retry that just fired is looking at its predecessor's success.
          // Nothing owed. Note this is NOT `installedVersion !== null`: a host
          // whose bytes landed but whose service never started is still owed
          // a boot, and settling on the bytes was how a half-completed first
          // install left a machine hostless with nothing retrying.
          settle();
          return;
        }
        if (!identity.isSignedIn()) {
          // RE-READ AT THE MOMENT OF ACTING, because the precondition is
          // consent and `getStatus()` above is a round trip. A sign-out
          // landing inside that await reaches the subscription as
          // `onChanged(false)`, which cancels any pending retry but cannot
          // reach into this continuation - so without this line it installs
          // a background service for an account that just left.
          // `removedByUser` is checked one step above for the same reason:
          // both halves of consent are read here, not at arming time.
          //
          // Left ARMED with NO retry scheduled: the next sign-in edge attempts
          // again, which is exactly the timing a signed-out launch already
          // has. A timer here would only fire into this same branch.
          log.info("[host-controller] local host boot deferred to a sign-in");
          return;
        }
        const outcome = await hostController.convergeReady(false, {
          kind: "background",
        });
        if (outcome.kind === "ok") {
          settle();
          log.info("[host-controller] local host boot complete", {
            kind: outcome.kind,
          });
          return;
        }
        // A RESOLVED non-ok is not a running host, and `busy` is the one that
        // argues otherwise. It reads as "a live host with active work declined
        // a byte swap" - but `E_HOST_BUSY` is a FAIL-SAFE, raised by
        // `assertHostNotBusy` whenever a live PID's idle state cannot be
        // determined at all (`/activity` timed out, refused, answered
        // malformed, or 404'd), which is exactly what a WEDGED host looks
        // like. Settling on it retired this process's only retry ladder for a
        // host that may never serve, and nothing downstream necessarily
        // covers that: the authority can only ensure a host the fleet can
        // NAME, and `readLastKnownLocalHostId` answers null outright for an
        // UNUSABLE enrollment record - it deliberately does not fall back to
        // `pid.json` there - so the wedge would wait for a relaunch.
        //
        // `deferred` (CLI lock held by another Traycer process), `failed`,
        // `installed-not-converged` and `stage-fingerprint-mismatch` are
        // ordinary return values too, so none of them reach the catch below -
        // and every one of them, `busy` included, can clear on its own, so
        // every one earns the next rung. `inFlight` clears in `finally`, so
        // nothing blocks that retry.
        log.warn("[host-controller] local host boot did not complete", {
          kind: outcome.kind,
        });
        scheduleRetry();
      } catch (error: unknown) {
        // A THROW is not an outcome. `settled` used to be set before this work
        // began and the rejection had nowhere to land, so one transient IPC
        // failure retired the only automatic boot actor for the whole
        // process: the signed-in user stayed in the unavailable-host flow until
        // a manual retry or a relaunch. Only a running host or a removed one
        // settles the arm; a failure schedules the next rung.
        log.warn("[host-controller] local host boot attempt failed", {
          error: String(error),
        });
        scheduleRetry();
      } finally {
        inFlight = false;
      }
    })();
  };

  // Subscribed even when already signed in. The subscription is what a
  // signed-out launch (and a sign-out mid-ladder) re-arms AGAINST; a
  // successful or terminal attempt disposes it from inside.
  unsubscribe = identity.onChanged((signedIn) => {
    if (!signedIn) {
      // Consent withdrawn: nothing may fire until it is given again, and when
      // it is, the account gets a fresh ladder rather than the tail of the
      // previous one.
      clearRetry();
      retryRung = 0;
      return;
    }
    // A rising edge attempts at once - UNLESS a retry is already scheduled.
    // The auth session emits `change` for every token refresh too, and each
    // of those reaches here as `signedIn: true` while still signed in; letting
    // them attempt would replace the ladder's pacing with the token's. A real
    // re-login always arrives with no timer pending, because the sign-out
    // before it cleared the one there was.
    if (retryTimer === null) attempt();
  });
  if (identity.isSignedIn()) {
    attempt();
  }
  return dispose;
}

// Launch-time boot reconcile (Fixup B1 + B2): converges any pre-existing
// activation debt AND applies an eligible staged update, in the correct
// priority order. `applyStaged`'s own no-op fast path is broader than
// `activateInstalled`'s internal "ready update supersedes debt" branch (the
// former also short-circuits on `staged === null`), so the boot policy is
// decided explicitly here - apply when a stage is ready, activate when not -
// rather than delegating to `activateInstalled`'s narrower internal check.
// Exported (and kept in its own Electron-free module) so this can be
// exercised directly with `IpcHostController` / `HostUpdateMenuSurface`
// fakes, through the same path `runDeferred` calls - per the ticket, B1/B2
// must be proven through the production startup wiring, not by calling
// controller methods directly.
export async function runLaunchHostConvergeReconcile(
  hostController: IpcHostController,
  menu: HostUpdateMenuSurface,
): Promise<void> {
  const initialStatus = await hostController.getStatus();
  if (initialStatus.removedByUser) {
    log.info("[host-controller] launch converge skipped for removed host");
    return;
  }

  // An `unavailable` service is not registered at all, so NOTHING can reach
  // this host until it is re-registered - and the decision arms below run
  // only after `stageLatest()` settles, which joins a controller-owned
  // release download that can take minutes on a slow link. Recovering first
  // is what keeps a reinstall from leaving the user hostless for the length
  // of a WAN transfer. An already-staged update keeps its apply-first
  // precedence instead: applying is itself the fastest route to a running
  // host, and it re-registers on the way.
  //
  // This arm repairs a service that went missing from under an INSTALLED
  // host; `isUnavailableInstalledHost` is what keeps it from ever being the
  // thing that performs the first install.
  //
  // FIRST INSTALL IS NOT MISSING - it lives in `armLocalHostBootOnSignIn`
  // above, sign-in gated and retrying, and it is deliberately NOT an arm of
  // this reconciler. If you arrived here tracing "nothing installs a
  // first-ever host" or "the launch converge failed once and nothing tried
  // again", that is the sibling to read; the two pinned tests below ("does
  // not provision a host that was never installed", "does not turn a failed
  // apply into a first install") are still true and still describe THIS
  // function - a one-shot reconcile. When both this arm and that actor find
  // an installed host down at launch, both ask `convergeReady(false)` and the
  // controller coalesces the two onto one job.
  const recovery =
    !initialStatus.updateReady && isUnavailableInstalledHost(initialStatus)
      ? await hostController.convergeReady(false, { kind: "background" })
      : null;
  if (recovery !== null) {
    log.info("[host-controller] launch converge recovered an absent service", {
      kind: recovery.kind,
    });
  }

  // Registry discovery stages asynchronously so a generic refresh never
  // blocks its caller on a WAN download. At launch that is insufficient: a
  // reconcile which samples status before staging finishes would leave the
  // new release dormant until a later launch. Join (or start) the same
  // controller-owned staging work, then make the apply/activate decision
  // from the post-stage status.
  await hostController.stageLatest();
  const status = await hostController.getStatus();
  if (status.removedByUser) {
    log.info("[host-controller] launch converge skipped after staging removal");
    return;
  }

  let outcome: MutationOutcome<
    ApplyStagedOk | ActivateInstalledOk | ConvergeReadyOk
  > | null = null;
  if (status.updateReady) {
    const applied = await hostController.applyStaged("launch", false);
    outcome = await recoverAfterFailedApply(hostController, applied);
  } else if (
    status.activation === "pendingActivation" ||
    status.activation === "activationUnknown"
  ) {
    outcome = await hostController.activateInstalled(false);
  } else if (isUnavailableInstalledHost(status) && recovery === null) {
    // `recovery === null` keeps this from re-running a recovery the pre-stage
    // pass already attempted, since repeating a failure seconds later helps
    // nobody.
    outcome = backgroundMutationOutcome(
      await hostController.convergeReady(false, { kind: "background" }),
    );
  }

  const effectiveOutcome = outcome ?? recovery;
  if (effectiveOutcome === null) {
    log.info("[host-controller] launch converge has no activation debt", {
      activation: status.activation,
    });
    return;
  }

  log.info("[host-controller] launch converge reconcile complete", {
    updateReady: status.updateReady,
    kind: effectiveOutcome.kind,
    recoveredBeforeStaging: recovery !== null,
  });
  // Fixup B1: a successful apply just moved `installedVersion` (and cleared
  // the stage), so the cache/menu built from the pre-apply registry snapshot
  // is now stale - force a re-probe so `updateAvailable` (now correctly
  // `updateReady`-derived) reflects the freshly applied version instead of
  // advertising the update we just installed. `activateInstalled` never moves
  // `installedVersion`, so there's nothing new to advertise on that branch.
  if (status.updateReady && effectiveOutcome.kind === "ok") {
    await refreshHostRegistryIfNotRemoved(hostController, menu, {
      force: true,
      maxAgeMs: null,
    });
  }
}

/**
 * The other half of the recovery arm above: what happens when a ready stage
 * takes apply-first precedence and then the apply does not land.
 *
 * `applyStaged` RESOLVES `failed` / `stage-fingerprint-mismatch` /
 * `installed-not-converged` rather than throwing, and the pre-stage recovery
 * deliberately stood down because a stage was ready. So a host whose service
 * was ALSO absent had nobody left to re-register it: launch logged an outcome
 * and returned, leaving the machine unreachable until the next launch or a
 * manual repair - through the one pass that exists to guarantee the opposite.
 *
 * Only `busy` passes through untouched: it is the controller's own gate saying
 * the host has work in progress, and `convergeReady` consults the same gate.
 * `deferred` does NOT pass through, because it is not one fact. The same arm
 * carries at least three: another Traycer process holding the CLI lock, a
 * launch-trigger apply on a removed host, and - the one that broke this - a
 * registry outage leaving the stage un-eligibility-checked
 * (`host-controller.ts`, `coalesceIntent`'s `eligibleStage === null` return).
 * That last one holds no lock at all; skipping recovery for it left an
 * installed service unregistered because a NETWORK PROBE failed. The status
 * gates below sort them out instead: a removed host is caught by the re-read,
 * and a lock actually held is `convergeReady`'s own problem - it runs its
 * bounded CLI-lock retry and resolves `deferred` itself rather than throwing,
 * by which time the other process may well have finished.
 *
 * `removedByUser` is re-read rather than inherited: the apply can take
 * minutes, and a user who removed the host during it must not be handed a
 * reinstall as a consolation prize.
 */
async function recoverAfterFailedApply(
  hostController: IpcHostController,
  applied: MutationOutcome<ApplyStagedOk>,
): Promise<MutationOutcome<ApplyStagedOk | ConvergeReadyOk>> {
  if (applied.kind === "ok" || applied.kind === "busy") {
    return applied;
  }
  const status = await hostController.getStatus();
  if (status.removedByUser) {
    log.info("[host-controller] launch converge skipped after apply removal");
    return applied;
  }
  // A failed apply is not by itself an activation problem - without this gate
  // the arm would cycle the service on every unsuccessful update.
  if (!isUnavailableInstalledHost(status)) {
    return applied;
  }
  log.info(
    "[host-controller] launch converge recovering an absent service after a failed apply",
    { applyKind: applied.kind },
  );
  return backgroundMutationOutcome(
    await hostController.convergeReady(false, { kind: "background" }),
  );
}
