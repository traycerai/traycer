import { log } from "../app/logger";
import type { HostAutoUpdateOutcome } from "../host/host-auto-update";

// First-pass `before-quit` sequencing for a quit driven by `quitAndInstall`
// (the user chose "Restart" to install a downloaded update). Extracted from
// the inline handler so the ordering contract is unit-testable:
//
//   host reconcile -> renderer projection drain -> shell flush + quit
//
// Every step is fail-open: nothing here may block the install. The renderer
// drain exists because the update path skips the regular quit interception
// (prompting would swallow the install), and without it the state store is
// flushed with only the last ambient debounced writes - tabs/drafts touched
// while the host reconcile ran (up to two minutes) would be lost on the
// post-install relaunch.

export interface UpdateInstallQuitDeps {
  // Best-effort idle-gated host update (`reconcileHostAutoUpdate`, which
  // reports failure as an outcome rather than throwing); a throw is still
  // contained here so it can never block the install.
  readonly reconcileHostUpdate: () => Promise<HostAutoUpdateOutcome>;
  // True while the downloaded update is still pending install. Flips false
  // when `quitAndInstall` failed while the reconcile ran - in that case the
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
    const outcome = await deps.reconcileHostUpdate();
    log.info("[host-auto-update] quit reconcile complete", { outcome });
  } catch (err) {
    log.warn("[host-auto-update] quit reconcile threw", err);
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
