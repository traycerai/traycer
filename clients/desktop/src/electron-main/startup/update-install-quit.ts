import { log } from "../app/logger";


export const QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS = 10_000;

export interface UpdateInstallQuitDeps {
  // Bounded wait for whatever `HostController` mutation is CURRENTLY in flight to settle (`HostController.awaitMutationLaneIdle`) - never starts a new one.
  // `HostController` itself never rejects, but a throw is still contained here so it can never block the install.
  readonly drainHostMutation: () => Promise<boolean>;
  // True while the downloaded update is still pending install. Flips false
  // when `quitAndInstall` failed while the drain ran - in that case the
  // failure was surfaced to the user and the app must stay open.
  readonly isInstallPending: () => boolean;
  readonly drainRendererProjection: () => Promise<unknown>;
  // Flush shell state (desktop state store + window geometry) and let the
  // quit proceed.
  readonly authorizeQuitAfterFlush: () => void;
  // Abort the quit and stay open (install failed under us).
  readonly stayOpen: () => void;
}

export async function runUpdateInstallQuitSequence(
  deps: UpdateInstallQuitDeps,
): Promise<void> {
  try {
    const drained = await deps.drainHostMutation();
    log.info("[host-controller] quit-time mutation drain complete", {
      drained,
    });
  } catch (err) {
    log.warn("[host-controller] quit-time mutation drain threw", err);
  }

  // If `quitAndInstall` failed in the meantime (e.g. read-only volume), the
  // failure was surfaced as an error - don't quit out from under the user;
  // let them read it and retry. Only the still-pending install proceeds.
  if (!deps.isInstallPending()) {
    log.info(
      "[desktop] before-quit - install failed during reconcile, staying open",
    );
    deps.stayOpen();
    return;
  }

  try {
    await deps.drainRendererProjection();
  } catch (err) {
    log.warn(
      "[desktop] update-install renderer drain failed - quitting anyway",
      err,
    );
  }

  // `quitAndInstall` can still fail asynchronously while the drain was in
  // flight - re-check before authorizing the quit.
  if (!deps.isInstallPending()) {
    log.info(
      "[desktop] before-quit - install failed during renderer drain, staying open",
    );
    deps.stayOpen();
    return;
  }
  deps.authorizeQuitAfterFlush();
}
