import { log } from "../app/logger";
import { respawnHost } from "../app/host-respawn";
import { canReachHostWebsocketUrl, readPidMetadata } from "./host-lifecycle";
import type { IpcHostLifecycle } from "../ipc/runner-ipc-bridge";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";

/**
 * Steady-state watchdog for the CLI-owned host - the Windows substitute for
 * the process supervision launchd (KeepAlive) and systemd (Restart) provide
 * natively on the other platforms. Wired up for win32 only (see
 * `desktop-startup.ts`); the module itself is platform-agnostic for tests.
 *
 * `HostLifecycle` is purely pid.json-watcher driven, which leaves a blind
 * spot: a host that dies WITHOUT running its teardown (Task Manager End
 * Task, crash, OOM kill) never rewrites pid.json, so no watcher event
 * fires, the cached snapshot stays "reachable", and the renderer retries a
 * dead WebSocket forever. The Scheduled Task can't recover it either - its
 * hidden-launcher action detaches the host and exits, so from Task
 * Scheduler's perspective the job already completed and
 * restart-on-failure has nothing to react to.
 *
 * This monitor closes the loop: it periodically re-probes the endpoint the
 * current snapshot advertises, and when the endpoint is confirmed dead it
 * distinguishes the two causes by what's on disk:
 *
 *  - pid.json still present  → the host died unexpectedly. Auto-respawn
 *    through `respawnHost` (the platform-correct entry point - it dedups
 *    concurrent respawns and refuses when the user removed the host).
 *  - pid.json gone           → a deliberate stop (`traycer host stop`,
 *    uninstall). Just demote the snapshot so the renderer's gate takes
 *    over; resurrecting the host would fight the user.
 *
 * While the snapshot is null (host known-down, respawn/provision flows in
 * progress) the monitor idles - recovery ownership stays with those flows.
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
      const metadata = await readMetadata(deps.host.pidMetadataFile);
      if (disposed || deps.host.isDisposed) return;
      if (metadata === null) {
        log.info(
          "[host-health] endpoint down and pid metadata gone - treating as a deliberate stop",
        );
        await deps.host.reloadSnapshotFromDisk();
        return;
      }
      if (respawnsSinceRecovery >= MAX_AUTO_RESPAWNS_WITHOUT_RECOVERY) {
        log.warn(
          "[host-health] endpoint down but auto-respawn budget exhausted - leaving recovery to the renderer",
          { pid: metadata.pid },
        );
        await deps.host.reloadSnapshotFromDisk();
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
