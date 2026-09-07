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

export interface SignedInGate {
  isSignedIn(): boolean;
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

// Named once so a future activation state or an extra condition cannot land in one arm and not the others.
function isUnavailableInstalledHost(status: HostControllerStatus): boolean {
  return (
    status.activation === "unavailable" && status.installedVersion !== null
  );
}

// "Update to X" gates on `updateReady` OR activation debt (Renderer surfaces cutover ticket, D4/D5): a ready update supersedes debt (its own version is the label).
// `null` (up to date, no debt, or `activation: "unavailable"` - that's the gate's domain, never a menu affordance) hides the row entirely.
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

export function applyHostUpdateMenuState(
  menu: HostUpdateMenuSurface,
  status: HostControllerStatus,
): void {
  menu.setHostUpdateAvailableVersion(deriveHostUpdateMenuVersion(status));
}

// `refreshRegistryUpdateState` never throws and is internally serialized (`registryRefreshQueue`), so overlapping calls are safe.
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

export const LOCAL_HOST_BOOT_RETRY_LADDER_MS: readonly number[] = [
  30_000, 60_000, 120_000, 300_000,
];

/**
 * BOOTING THIS MACHINE'S HOST, and the actor that owns it: install when there has never been one, start when there is one and it is not running, and keep trying.
 * Signed-in gated (below).
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
    // TERMINAL, and that has to be recorded BEFORE the resources go, because an attempt can be in flight right now.
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
        // The check has to be before the mutation, not only after it.
        if (settled) return;
        if (status.removedByUser) {
          log.info(
            "[host-controller] local host boot skipped for removed host",
          );
          settle();
          return;
        }
        if (status.activation !== "unavailable") {
          // `unavailable` is the one activation state that means no runtime is running.
          settle();
          return;
        }
        if (!identity.isSignedIn()) {
          // A sign-out landing inside that await reaches the subscription as `onChanged(false)`, which cancels any pending retry but cannot reach into this continuation.
          // `removedByUser` is checked one step above for the same reason: both halves of consent are read here, not at arming time.
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
        log.warn("[host-controller] local host boot did not complete", {
          kind: outcome.kind,
        });
        scheduleRetry();
      } catch (error: unknown) {
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
    if (retryTimer === null) attempt();
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

  const recovery =
    !initialStatus.updateReady && isUnavailableInstalledHost(initialStatus)
      ? await hostController.convergeReady(false, { kind: "background" })
      : null;
  if (recovery !== null) {
    log.info("[host-controller] launch converge recovered an absent service", {
      kind: recovery.kind,
    });
  }

  // Registry discovery stages asynchronously so a generic refresh never blocks its caller on a WAN download.
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
  // `activateInstalled` never moves `installedVersion`, so there's nothing new to advertise on that branch.
  if (status.updateReady && effectiveOutcome.kind === "ok") {
    await refreshHostRegistryIfNotRemoved(hostController, menu, {
      force: true,
      maxAgeMs: null,
    });
  }
}

/** `removedByUser` is re-read rather than inherited: the apply can take minutes, and a user who removed the host during it must not be handed a reinstall as a consolation prize. */
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
