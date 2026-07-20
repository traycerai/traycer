import { log } from "../app/logger";

// First-pass `before-quit` sequencing for a quit driven by `quitAndInstall`
// (the user chose "Restart" to install a downloaded update). Extracted from
// the inline handler so the ordering contract is unit-testable:
//
//   host mutation drain -> renderer projection drain -> shell flush + quit
//
// Every step is fail-open: nothing here may block the install. The renderer
// drain exists because the update path skips the regular quit interception
// (prompting would swallow the install), and without it the state store is
// flushed with only the last ambient debounced writes - tabs/drafts touched
// while the drain waited (up to its bound) would be lost on the post-install
// relaunch.

// Fixup B4: quit is instant everywhere else - this bound is the tech plan's
// one deliberate, bounded exception ("quit keeps a <=10s best-effort drain of
// an in-flight mutation"), never a download. It used to sit at 2 minutes
// (`awaitMutationLaneIdle`'s call site in `desktop-startup.ts`), matching the
// CLI runner's own generous per-call timeout headroom rather than the tech
// plan's quit-time bound - a wedged mutation could hold the app open for two
// minutes after the user asked to restart-and-install. Exported (and moved
// here, not left as a private constant in the Electron-heavy startup module)
// so its value is directly assertable in a unit test, since actually waiting
// out a multi-second drain isn't practical for a unit suite.
export const QUIT_HOST_MUTATION_DRAIN_TIMEOUT_MS = 10_000;

export interface UpdateInstallQuitDeps {
  // Bounded wait for whatever `HostController` mutation is CURRENTLY in
  // flight to settle (`HostController.awaitMutationLaneIdle`) - never
  // starts a new one. `HostController` itself never rejects, but a throw is
  // still contained here so it can never block the install.
  readonly drainHostMutation: () => Promise<boolean>;
  // True while the downloaded update is still pending install. Flips false
  // when `quitAndInstall` failed while the drain ran - in that case the
  // failure was surfaced to the user and the app must stay open.
  readonly isInstallPending: () => boolean;
  // Bounded renderer projection drain: the fresh-unsynced-snapshot request,
  // which the renderer answers only after flushing its per-window projection
  // (tabs/canvas/drafts) into the desktop state store. Bounded per-window
  // with a cached-snapshot fallback, so a dead renderer resolves quickly.
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
