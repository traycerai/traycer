import { log } from "../app/logger";
import { respawnHost } from "../app/host-respawn";
import { canReachHostWebsocketUrl, readPidMetadata } from "./host-lifecycle";
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
  readonly respawn: (() => Promise<void>) | undefined;
}

export interface HostHealthMonitor {
  dispose(): void;
}

export function startHostHealthMonitor(
  deps: HostHealthMonitorDeps,
): HostHealthMonitor {
  const probe = deps.probe ?? canReachHostWebsocketUrl;
  const readMetadata = deps.readMetadata ?? readPidMetadata;
  const respawn = deps.respawn ?? (() => respawnHost(deps.host));
  let consecutiveFailures = 0;
  let respawnsSinceRecovery = 0;
  let ticking = false;
  let disposed = false;

  const tick = async (): Promise<void> => {
    // A tick that outlives its interval (slow probe + slow respawn) must
    // not stack a second concurrent tick on top.
    if (ticking || disposed || deps.host.isDisposed) return;
    ticking = true;
    try {
      const snapshot = deps.host.getSnapshot();
      if (snapshot === null) {
        // Host known-down: the gate/ensure/respawn flows own recovery.
        consecutiveFailures = 0;
        return;
      }
      if (await probe(snapshot.websocketUrl)) {
        consecutiveFailures = 0;
        respawnsSinceRecovery = 0;
        return;
      }
      // Re-check after every await: dispose() landing during a slow probe
      // or metadata read (app quit) must not let this in-flight tick spawn
      // a host the app is tearing down.
      if (disposed || deps.host.isDisposed) return;
      consecutiveFailures += 1;
      if (consecutiveFailures < CONFIRMED_DOWN_AFTER_FAILURES) return;
      consecutiveFailures = 0;

      // Reload FIRST, then decide. The advertised endpoint is dead, but the
      // disk may already name a healthy replacement (launchd/systemd respawned
      // the host on a new port and the watcher edge was missed) - converge on
      // it instead of restarting a host that is actually alive.
      const surfaced = await deps.host.reloadSnapshotFromDisk();
      if (disposed || deps.host.isDisposed) return;
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
      if (disposed || deps.host.isDisposed) return;
      if (metadata === null) {
        log.info(
          "[host-health] endpoint down and pid metadata gone - treating as a deliberate stop",
        );
        return;
      }
      if (respawnsSinceRecovery >= MAX_AUTO_RESPAWNS_WITHOUT_RECOVERY) {
        // The reload above already demoted the snapshot; nothing else to do.
        log.warn(
          "[host-health] endpoint down but auto-respawn budget exhausted - leaving recovery to the renderer",
          { pid: metadata.pid },
        );
        return;
      }
      respawnsSinceRecovery += 1;
      log.warn(
        "[host-health] endpoint down with live pid metadata - auto-respawning",
        { pid: metadata.pid, attempt: respawnsSinceRecovery },
      );
      await respawn();
    } catch (err) {
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
