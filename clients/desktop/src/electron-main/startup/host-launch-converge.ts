import { log } from "../app/logger";
import { refreshRegistryUpdateState } from "../ipc/host-management-ipc";
import { isHostRemovedByUser } from "../host/host-removal-state";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  ConvergeReadyOk,
  HostControllerStatus,
  MutationOutcome,
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
 * Narrow on purpose: {@link armFirstInstallOnSignIn} needs consent, not
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
/**
 * THE FIRST INSTALL, and the actor that performs it.
 *
 * Deliberately a SIBLING of {@link runLaunchHostConvergeReconcile} rather than
 * an arm inside it. That reconciler's contract is "settle the debt of a host
 * that EXISTS" - its update, activation and recovery arms are all structurally
 * unable to first-install, by their own predicates: `deriveUpdateReady`
 * returns false outright when `installedVersion` is null, nothing is running so
 * activation reads `"unavailable"` rather than pending/unknown, and
 * `isUnavailableInstalledHost` requires an installed version by definition.
 * Two tests pin that contract, and it stays true; first install is a different
 * action with a different precondition, so it gets its own entry point.
 *
 * ## Why main performs it at all
 *
 * The RENDERER used to: a once-per-mount `convergeReady` in the local-host
 * gate (deleted in P3.4). Redesign P1.3 retired that - correctly, because two
 * process actors for one host is what made the ∅ definition undecidable - and
 * moved boot-time provisioning intent to the selection authority. But the
 * authority asks through `LocalHostEnsurePort` keyed on a hostId it reads from
 * the fleet, and the fleet reads the local id from the enrollment and
 * pid-metadata files. On a first-ever start those files do not exist, the id is
 * null, and `requestLocalEnsureIfWanted` returns on its second line. The
 * authority cannot ask for a host that has never existed, so the intent had
 * moved to an actor unable to exercise it in the one case where boot-time
 * provisioning IS the point: a first launch sat on "Starting local Traycer
 * Host…" with nothing starting.
 *
 * The split, stated once: launch-time FIRST INSTALL here; selection-time
 * ensure of an existing-but-down host in the authority. D14/C5's "one
 * sanctioned process action" is untouched - that constraint scopes the
 * AUTHORITY, which still performs exactly one.
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
 * also the pre-retirement TIMING, since the gate only mounted after sign-in.
 *
 * `removedByUser` is the other half of consent and is checked at the moment of
 * acting: a user who removed the host has `installedVersion === null` too, and
 * must not have it reinstalled underneath them.
 *
 * Returns a disposer for the subscription. One-shot: the first attempt wins,
 * whether it installs or declines.
 */
export function armFirstInstallOnSignIn(
  hostController: IpcHostController,
  identity: SignedInGate,
): () => void {
  let settled = false;
  let unsubscribe: (() => void) | null = null;

  const dispose = (): void => {
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  let inFlight = false;
  const attempt = (): void => {
    if (settled || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const status = await hostController.getStatus();
        if (status.removedByUser) {
          log.info("[host-controller] first install skipped for removed host");
          settled = true;
          dispose();
          return;
        }
        if (status.installedVersion !== null) {
          // Something installed it between arming and now - a concurrent
          // recovery arm, or a previous launch that finished late. Nothing
          // owed.
          settled = true;
          dispose();
          return;
        }
        if (!identity.isSignedIn()) {
          // RE-READ AT THE MOMENT OF ACTING, because the precondition is
          // consent and `getStatus()` above is a round trip. A sign-out
          // landing inside that await reaches the subscription as
          // `onChanged(false)`, which this arm ignores by design - it only
          // acts on the rising edge - so without this line the continuation
          // installs a background service for an account that just left.
          // `removedByUser` is checked one step above for the same reason:
          // both halves of consent are read here, not at arming time.
          //
          // Left ARMED, like every other non-terminal outcome below: the next
          // sign-in edge attempts again, which is exactly the timing a signed
          // -out launch already has.
          log.info("[host-controller] first install deferred to a sign-in");
          return;
        }
        const outcome = await hostController.convergeReady(false);
        if (outcome.kind !== "ok") {
          // A RESOLVED non-ok is not an install. `busy`, `deferred` and
          // `failed` are ordinary return values, so they never reach the catch
          // below - the throw fix left this half open, and `outcome.kind` was
          // logged without ever being read. Settling here retired the only
          // automatic first-install actor for the process and disposed the
          // sign-in edge it would have retried from, while logging "complete"
          // about a machine that still has no host.
          //
          // Left ARMED deliberately, matching the throw arm: the next sign-in
          // edge attempts again. `inFlight` clears in `finally`, so nothing
          // blocks that retry.
          log.warn("[host-controller] first install did not complete", {
            kind: outcome.kind,
          });
          return;
        }
        settled = true;
        dispose();
        log.info("[host-controller] first install complete", {
          kind: outcome.kind,
        });
      } catch (error: unknown) {
        // A THROW is not an outcome. `settled` used to be set before this work
        // began and the rejection had nowhere to land, so one transient IPC
        // failure retired the only automatic first-install actor for the whole
        // process: the signed-in user stayed in the unavailable-host flow until
        // a manual retry or a relaunch. Only a terminal STATUS or a completed
        // convergence settles the arm; a failure leaves it armed, so the next
        // sign-in edge tries again.
        log.warn("[host-controller] first install attempt failed", {
          error: String(error),
        });
      } finally {
        inFlight = false;
      }
    })();
  };

  // Subscribed even when already signed in, which the immediate-attempt path
  // used to skip. The subscription is what a contained failure re-arms
  // AGAINST: without it, a first attempt that threw at launch had no later
  // edge to retry from at all. A successful or terminal attempt disposes it
  // from inside, so the one-shot contract is unchanged for every path that
  // actually reaches an outcome.
  unsubscribe = identity.onChanged((signedIn) => {
    if (signedIn) attempt();
  });
  if (identity.isSignedIn()) {
    attempt();
  }
  return dispose;
}

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
  // FIRST INSTALL IS NOT MISSING - it lives in `armFirstInstallOnSignIn`
  // above, sign-in gated, and it is deliberately NOT an arm of this
  // reconciler. If you arrived here tracing "nothing installs a first-ever
  // host", that is the sibling to read; the two pinned tests below
  // ("does not provision a host that was never installed", "does not turn a
  // failed apply into a first install") are still true and still describe
  // THIS function.
  const recovery =
    !initialStatus.updateReady && isUnavailableInstalledHost(initialStatus)
      ? await hostController.convergeReady(false)
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
    outcome = await hostController.convergeReady(false);
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
  return hostController.convergeReady(false);
}
