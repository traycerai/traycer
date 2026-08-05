import { log } from "../app/logger";
import type { HostControllerStatus } from "../host/host-controller-types";

// Narrowed to the one method this module drives, the same "narrow interface
// for testability" pattern `HostUpdateMenuSurface` uses in
// `host-launch-converge.ts`. The real `HostController` satisfies it
// structurally.
export interface HostInstallStateSurface {
  getStatus(): Promise<HostControllerStatus>;
}

// The one lifecycle method the boot seam drives here. Same narrow-interface
// pattern, so the wiring below is exercised against a fake rather than only
// through a full Electron boot.
export interface HostBootstrapSurface {
  bootstrap(options: { readonly hostInstalled: boolean }): Promise<void>;
}

/**
 * Whether this machine has a host install record at all, for
 * `HostLifecycle.bootstrap`'s readiness short-circuit.
 *
 * `installedVersion !== null` is the same fact `isUnavailableInstalledHost`
 * (`host-launch-converge.ts`) gates every recovery arm on: `activation:
 * "unavailable"` describes the RUNNING runtime, so it cannot by itself tell a
 * fresh machine apart from an installed host whose service went missing. Only
 * the install record separates them, and the lifecycle must not read it
 * directly - its contract forbids consulting the service controller, so the
 * boot seam resolves it here and hands the answer in.
 *
 * Resolved in its own Electron-free module (like `host-health-respawn.ts`) so
 * the fallback below is unit-testable through the same function the boot seam
 * calls, rather than only by driving the whole Electron boot sequence.
 *
 * Two separate reasons this catches rather than propagates:
 *
 * 1. **It must not throw.** `timed()` swallows a rejection from the bootstrap
 *    step, so an error escaping here would skip `bootstrap` altogether - no
 *    readiness wait, no pid-metadata watcher, and `hostReady` still resolving
 *    into a health monitor with nothing to monitor.
 * 2. **It answers `true`, not `false`.** `true` preserves the historical wait,
 *    so the one thing an unreadable record cannot do is silently strip a
 *    legitimate readiness wait - and its `HOST_NOT_READY` signal - from a host
 *    that really is installed and merely slow. The cost of being wrong that
 *    way is a slow launch; being wrong the other way loses a real failure
 *    report. (Both answers still reach `bootstrap`, which installs the watcher
 *    either way.)
 *
 * Note this catch is narrower than it looks: `readDesktopHostInstallRecord` is
 * deliberately tolerant and maps read/parse/shape failures to `null`, so a
 * corrupt or unreadable record surfaces as `installedVersion: null` - i.e. as
 * "never installed" - rather than as a rejection here. Accepted: the watcher
 * is installed regardless, so a host that publishes late is still picked up.
 */
export async function readHostInstalledForBootstrap(
  hostController: HostInstallStateSurface,
): Promise<boolean> {
  try {
    const status = await hostController.getStatus();
    return status.installedVersion !== null;
  } catch (err) {
    log.warn("[host] install-state read failed - keeping the readiness wait", {
      err,
    });
    return true;
  }
}

/**
 * The boot seam's whole host-bootstrap step: resolve the install state, then
 * hand it to the lifecycle.
 *
 * Deliberately one function rather than two calls inlined at the seam. The
 * startup test hooks replace `runDeferredBackground` wholesale, so anything
 * written inline there is unreachable from a test - hard-coding
 * `hostInstalled: true`, or dropping the read entirely, would restore the
 * 60s regression while every unit test still passed. Composing here keeps the
 * seam a single call and puts the wiring under test.
 */
export async function bootstrapHostWithInstallState(
  host: HostBootstrapSurface,
  hostController: HostInstallStateSurface,
): Promise<void> {
  return host.bootstrap({
    hostInstalled: await readHostInstalledForBootstrap(hostController),
  });
}
