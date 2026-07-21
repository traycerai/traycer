import { log } from "../app/logger";
import { HostRecoveryDeferredError } from "../startup/host-health-respawn";
import {
  canReachHostWebsocketUrl,
  readPidMetadata,
  readPidMetadataState,
} from "./host-lifecycle";
import { isPublishedHostEndpointReachable } from "./host-endpoint-reachability";
import type { IpcHostLifecycle } from "../ipc/runner-ipc-bridge";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";

/**
 * Steady-state watchdog for the CLI-owned host. Runs on every platform (see
 * `desktop-startup.ts`); auto-respawn matters most on Windows, where the
 * Scheduled Task cannot restart-on-failure (its hidden-launcher action
 * detaches the host and exits, so the job "completed" long before the host
 * can die), while the snapshot-convergence duty matters everywhere.
 *
 * `HostLifecycle`'s steady state is pid.json-watcher driven plus a
 * retry-until-reachable ladder for metadata whose endpoint doesn't answer.
 * That still leaves a blind spot: a host that dies WITHOUT running its
 * teardown (Task Manager End Task, crash, OOM kill) never rewrites
 * pid.json, so no watcher event fires, the cached snapshot stays
 * "reachable", and the renderer retries a dead WebSocket forever.
 *
 * This monitor closes the loop: it periodically re-probes the endpoint the
 * current snapshot advertises, and when the endpoint is confirmed dead it
 * first re-reads the disk - a supervisor (launchd KeepAlive / systemd
 * Restart) may already have respawned the host on a NEW port, in which case
 * a reload converges the stale snapshot and nothing needs restarting. Only
 * when the disk still names an unreachable host does it distinguish:
 *
 *  - pid.json still present  → the host died unexpectedly. Auto-respawn
 *    through `respawnHost` (the platform-correct entry point - it dedups
 *    concurrent respawns and refuses when the user removed the host).
 *  - pid.json gone           → a deliberate stop (`traycer host stop`,
 *    uninstall). Just demote the snapshot so the renderer's gate takes
 *    over; resurrecting the host would fight the user.
 *
 * While the snapshot is null (host known-down, respawn/provision flows in
 * progress) the monitor idles - recovery ownership stays with those flows
 * and the lifecycle's own reachability retry ladder.
 */

const HEALTH_POLL_INTERVAL_MS = 15_000;
// Two consecutive failed probes before acting, so one transiently refused
// connect (host mid-GC, socket backlog blip) doesn't trigger a restart.
const CONFIRMED_DOWN_AFTER_FAILURES = 2;
// A crash-looping host gets a bounded number of automatic restarts; after
// that the renderer's unavailable card (manual Retry) is the escape hatch.
// Any successful probe resets the budget.
const MAX_AUTO_RESPAWNS_WITHOUT_RECOVERY = 3;

export interface HostHealthMonitorDeps {
  readonly host: IpcHostLifecycle;
  /** Test seams; production callers pass undefined. */
  readonly intervalMs: number | undefined;
  readonly probe: ((websocketUrl: string) => Promise<boolean>) | undefined;
  readonly readMetadata:
    ((path: string) => Promise<DesktopLocalHostSnapshot | null>) | undefined;
  /**
   * The platform-correct recovery entry point - production callers pass
   * `HostController.recoverIfDown()` wrapped to this monitor's void/throw
   * contract (see `desktop-startup.ts`). No default: `HostController` is a
   * process singleton constructed by the caller, not something this module
   * can stand up itself.
   */
  readonly respawn: () => Promise<void>;
}

export interface HostHealthMonitor {
  dispose(): void;
}

interface PublishedHealthMetadata {
  readonly snapshot: DesktopLocalHostSnapshot;
  readonly startedAt: string | null;
}

function isCurrentPublishedSnapshot(
  current: DesktopLocalHostSnapshot,
  published: DesktopLocalHostSnapshot,
): boolean {
  return (
    current.pid === published.pid &&
    current.websocketUrl === published.websocketUrl
  );
}

export function startHostHealthMonitor(
  deps: HostHealthMonitorDeps,
): HostHealthMonitor {
  const probe = deps.probe ?? canReachHostWebsocketUrl;
  const readMetadata = deps.readMetadata ?? readPidMetadata;
  // Production needs the publication timestamp for A1's process-identity
  // check. Existing test callers can continue supplying a structural reader;
  // a missing timestamp deliberately falls through A1's indeterminate arm.
  const readPublishedMetadata = async (
    path: string,
  ): Promise<PublishedHealthMetadata | null> => {
    if (deps.readMetadata !== undefined) {
      const snapshot = await readMetadata(path);
      return snapshot === null ? null : { snapshot, startedAt: null };
    }
    const state = await readPidMetadataState(path);
    return state.kind === "parsed"
      ? { snapshot: state.snapshot, startedAt: state.startedAt }
      : null;
  };
  const respawn = deps.respawn;
  let consecutiveFailures = 0;
  let respawnsSinceRecovery = 0;
  let recoveryPending = false;
  let ticking = false;
  let disposed = false;

  const isDisposed = (): boolean => disposed || deps.host.isDisposed;

  const reloadRecoverySnapshot = async (): Promise<boolean> => {
    const surfaced = await deps.host.reloadSnapshotFromDisk();
    if (isDisposed()) return false;
    if (surfaced === null) {
      recoveryPending = true;
      return false;
    }
    recoveryPending = false;
    respawnsSinceRecovery = 0;
    log.info(
      "[host-health] recovery converged onto a reachable host snapshot",
      { pid: surfaced.pid },
    );
    return true;
  };

  const attemptRecovery = async (
    metadata: DesktopLocalHostSnapshot,
  ): Promise<void> => {
    if (respawnsSinceRecovery >= MAX_AUTO_RESPAWNS_WITHOUT_RECOVERY) {
      log.warn(
        "[host-health] endpoint down but auto-respawn budget exhausted - leaving recovery to the renderer",
        { pid: metadata.pid },
      );
      return;
    }
    respawnsSinceRecovery += 1;
    // The prior reload demoted the lifecycle snapshot. Retain ownership
    // through this attempt (including a generic failure) until a subsequent
    // reload proves that a host is actually published again.
    recoveryPending = true;
    log.warn(
      "[host-health] endpoint down with live pid metadata - auto-respawning",
      { pid: metadata.pid, attempt: respawnsSinceRecovery },
    );
    await respawn();
    if (isDisposed()) return;
    await reloadRecoverySnapshot();
  };

  const tick = async (): Promise<void> => {
    // A tick that outlives its interval (slow probe + slow respawn) must
    // not stack a second concurrent tick on top.
    if (ticking || disposed || deps.host.isDisposed) return;
    ticking = true;
    try {
      const snapshot = deps.host.getSnapshot();
      if (snapshot === null) {
        // A deferred recovery intentionally demotes the snapshot before the
        // foreign lock holder finishes. Keep ownership across that null
        // state; otherwise every later tick returns here and the dead host
        // is never retried.
        if (!recoveryPending) {
          consecutiveFailures = 0;
          return;
        }
        const metadata = await readMetadata(deps.host.pidMetadataFile);
        if (isDisposed()) return;
        if (metadata === null) {
          recoveryPending = false;
          return;
        }
        await attemptRecovery(metadata);
        return;
      }
      const published = await readPublishedMetadata(deps.host.pidMetadataFile);
      if (
        published !== null &&
        isCurrentPublishedSnapshot(snapshot, published.snapshot) &&
        (await isPublishedHostEndpointReachable(
          published.snapshot.websocketUrl,
          published.snapshot.pid,
          published.startedAt,
          probe,
        ))
      ) {
        consecutiveFailures = 0;
        respawnsSinceRecovery = 0;
        return;
      }
      // Re-check after every await: dispose() landing during a slow probe
      // or metadata read (app quit) must not let this in-flight tick spawn
      // a host the app is tearing down.
      if (isDisposed()) return;
      consecutiveFailures += 1;
      if (consecutiveFailures < CONFIRMED_DOWN_AFTER_FAILURES) return;
      consecutiveFailures = 0;

      // Reload FIRST, then decide. The advertised endpoint is dead, but the
      // disk may already name a healthy replacement (launchd/systemd respawned
      // the host on a new port and the watcher edge was missed) - converge on
      // it instead of restarting a host that is actually alive.
      const surfaced = await deps.host.reloadSnapshotFromDisk();
      if (isDisposed()) return;
      if (surfaced !== null) {
        log.info(
          "[host-health] stale snapshot converged onto a reachable host - no respawn needed",
          { pid: surfaced.pid },
        );
        respawnsSinceRecovery = 0;
        return;
      }

      // Endpoint dead and the reload demoted the snapshot. Read the pid
      // metadata AFTER the reload so the respawn decision reflects the current
      // disk, not a stale pre-reload read: a host stopped in the window
      // (`traycer host stop`, uninstall) unlinks pid.json, and resurrecting it
      // off a stale "still present" read would fight the user.
      const metadata = await readMetadata(deps.host.pidMetadataFile);
      if (isDisposed()) return;
      if (metadata === null) {
        log.info(
          "[host-health] endpoint down and pid metadata gone - treating as a deliberate stop",
        );
        return;
      }
      await attemptRecovery(metadata);
    } catch (err) {
      if (err instanceof HostRecoveryDeferredError) {
        respawnsSinceRecovery = Math.max(0, respawnsSinceRecovery - 1);
        recoveryPending = true;
        return;
      }
      // A failed respawn already surfaced through the lifecycle's error
      // event; the monitor only logs and keeps watching.
      log.warn("[host-health] auto-recovery attempt failed", err);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? HEALTH_POLL_INTERVAL_MS);
  // The watchdog must never be what keeps the Electron main process alive.
  timer.unref();

  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}
