import { log } from "../app/logger";
import { HostRecoveryDeferredError } from "../startup/host-health-respawn";
import {
  canReachHostWebsocketUrl,
  readPidMetadata,
  readPidMetadataState,
} from "./host-lifecycle";
import { isPublishedHostEndpointReachable } from "./host-endpoint-reachability";
import { readPublishedHostProcessLiveness } from "./host-process-liveness";
import type {
  HostProcessLiveness,
  HostRecoveryGovernor,
} from "./host-recovery-governor";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { IpcHostLifecycle } from "../ipc/runner-ipc-bridge";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";


const HEALTH_POLL_INTERVAL_MS = 15_000;
// Two consecutive failed probes before acting; one refused connect is not a restart.
const CONFIRMED_DOWN_AFTER_FAILURES = 2;
/** Diagnostics only: alive but silent this long is worth a support-report WARN. */
const UNREACHABLE_WARN_MS = 600_000;
/** Throttle OS liveness re-asks while the process is alive and not answering. */
const ALIVE_RECHECK_INTERVAL_MS = 120_000;

export interface HostHealthMonitorDeps {
  readonly host: IpcHostLifecycle;
  readonly intervalMs: number | undefined;
  readonly probe: ((websocketUrl: string) => Promise<boolean>) | undefined;
  readonly readMetadata:
    | ((path: string) => Promise<DesktopLocalHostSnapshot | null>)
    | undefined;
  /** Production callers pass `HostController.recoverIfDown()`; this module does not construct the controller. */
  readonly respawn: () => Promise<void>;
  /** Automatic-respawn authority; this monitor asks, it does not decide. */
  readonly governor: HostRecoveryGovernor;
  readonly readLiveness:
    | ((pidMetadataFile: string) => Promise<HostProcessLiveness>)
    | undefined;
}

export interface HostHealthMonitor {
  dispose(): void;
}

interface PublishedHealthMetadata {
  readonly snapshot: DesktopLocalHostSnapshot;
  readonly startIdentity: ProcessStartIdentity | null;
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
  // Test structural readers omit start identity; missing identity is indeterminate, not dead.
  const readPublishedMetadata = async (
    path: string,
  ): Promise<PublishedHealthMetadata | null> => {
    if (deps.readMetadata !== undefined) {
      const snapshot = await readMetadata(path);
      return snapshot === null ? null : { snapshot, startIdentity: null };
    }
    const state = await readPidMetadataState(path);
    return state.kind === "parsed"
      ? { snapshot: state.snapshot, startIdentity: state.startIdentity }
      : null;
  };
  const respawn = deps.respawn;
  const governor = deps.governor;
  const readLiveness = deps.readLiveness ?? readPublishedHostProcessLiveness;
  let consecutiveFailures = 0;
  let recoveryPending = false;
  let ticking = false;
  let disposed = false;
  // Once per stall, not once per tick.
  let busyLogged = false;
  let longStallLogged = false;
  let unreachableSince: number | null = null;
  // Throttles the alive-denial path that would otherwise re-probe a living host forever.
  let nextRecoveryAttemptAt = 0;
  // Throttles OS liveness re-asks while a busy hold is unbounded in time.
  let nextLivenessCheckAt = 0;

  const isDisposed = (): boolean => disposed || deps.host.isDisposed;

  const reloadRecoverySnapshot = async (): Promise<boolean> => {
    const surfaced = await deps.host.reloadSnapshotFromDisk();
    if (isDisposed()) return false;
    if (surfaced === null) {
      recoveryPending = true;
      return false;
    }
    recoveryPending = false;
    log.info(
      "[host-health] recovery converged onto a reachable host snapshot",
      { pid: surfaced.pid },
    );
    return true;
  };

  const attemptRecovery = async (
    metadata: DesktopLocalHostSnapshot,
  ): Promise<void> => {
    const decision = await governor.requestRespawn("health-monitor");
    if (isDisposed()) return;
    if (decision.kind === "denied") {
      if (decision.reason === "alive") {
        log.info(
          "[host-health] endpoint unresponsive but the host process exists - not respawning",
          { pid: metadata.pid },
        );
        // Keep ownership; stop asking at tick cadence while the process is alive.
        recoveryPending = true;
        nextRecoveryAttemptAt = Date.now() + ALIVE_RECHECK_INTERVAL_MS;
        return;
      }
      if (decision.reason === "backoff") {
        log.info("[host-health] respawn deferred by backoff", {
          pid: metadata.pid,
          retryInMs: decision.retryInMs,
        });
        recoveryPending = true;
        return;
      }
      log.warn(
        "[host-health] endpoint down but auto-respawn budget exhausted - leaving recovery to the renderer",
        { pid: metadata.pid },
      );
      return;
    }
    // Retain ownership until a later reload proves a host is published again.
    recoveryPending = true;
    log.warn(
      "[host-health] endpoint down with live pid metadata - auto-respawning",
      { pid: metadata.pid },
    );
    await respawn();
    if (isDisposed()) return;
    await reloadRecoverySnapshot();
  };

  /** True when the process is alive and merely unresponsive; do not demote or restart. */
  const isBusyRatherThanDown = async (
    snapshot: DesktopLocalHostSnapshot,
    now: number,
  ): Promise<boolean> => {
    const unreachableForMs =
      unreachableSince === null ? 0 : now - unreachableSince;
    // Throttle OS re-asks only after a long stall; a dying host is still checked every pass.
    const longStall = unreachableForMs >= UNREACHABLE_WARN_MS;
    if (longStall && now < nextLivenessCheckAt) {
      return true;
    }
    const liveness = await readLiveness(deps.host.pidMetadataFile);
    if (isDisposed()) return false;
    if (liveness === "dead") {
      nextLivenessCheckAt = 0;
      busyLogged = false;
      longStallLogged = false;
      return false;
    }
    if (longStall) {
      nextLivenessCheckAt = now + ALIVE_RECHECK_INTERVAL_MS;
    }
    if (longStall && !longStallLogged) {
      longStallLogged = true;
      log.warn(
        "[host-health] host process alive but unreachable for a long time - holding it busy, not dead",
        { pid: snapshot.pid, unreachableForMs },
      );
    }
    if (!busyLogged) {
      busyLogged = true;
      log.info(
        "[host-health] endpoint unresponsive but the host process exists - busy, holding the snapshot",
        { pid: snapshot.pid },
      );
    }
    return true;
  };

  const tick = async (): Promise<void> => {
    if (ticking || disposed || deps.host.isDisposed) return;
    ticking = true;
    try {
      const snapshot = deps.host.getSnapshot();
      if (snapshot === null) {
        // Keep ownership across a demoted snapshot or a dead host is never retried.
        if (!recoveryPending) {
          consecutiveFailures = 0;
          unreachableSince = null;
          // pid.json watcher is write-edge only; re-read so a never-rewritten file is not a wedge.
          await deps.host.reloadSnapshotFromDisk();
          return;
        }
        // Throttled only after an alive denial; lock-deferred/failed respawns retry next tick.
        if (Date.now() < nextRecoveryAttemptAt) return;
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
          published.startIdentity,
          probe,
        ))
      ) {
        consecutiveFailures = 0;
        busyLogged = false;
        longStallLogged = false;
        unreachableSince = null;
        // Carry a successful probe into the renderer-facing verdict (may still be `busy`).
        deps.host.noteEndpointAnswered();
        nextRecoveryAttemptAt = 0;
        nextLivenessCheckAt = 0;
        governor.noteHealthy();
        return;
      }
      // Dispose during a slow probe must not spawn a host the app is tearing down.
      if (isDisposed()) return;
      governor.noteUnhealthy();
      const now = Date.now();
      if (unreachableSince === null) unreachableSince = now;
      consecutiveFailures += 1;
      if (consecutiveFailures < CONFIRMED_DOWN_AFTER_FAILURES) return;
      consecutiveFailures = 0;

      // Liveness before reload (reload demotes). Only when pid.json still names this host.
      const publishedIsThisHost =
        published !== null &&
        isCurrentPublishedSnapshot(snapshot, published.snapshot);
      if (publishedIsThisHost && (await isBusyRatherThanDown(snapshot, now))) {
        return;
      }
      if (isDisposed()) return;

      // Reload before respawn: disk may already name a supervisor replacement on a new port.
      const surfaced = await deps.host.reloadSnapshotFromDisk();
      if (isDisposed()) return;
      if (surfaced !== null) {
        log.info(
          "[host-health] stale snapshot converged onto a reachable host - no respawn needed",
          { pid: surfaced.pid },
        );
        unreachableSince = null;
        busyLogged = false;
        longStallLogged = false;
        nextLivenessCheckAt = 0;
        governor.noteHealthy();
        return;
      }

      // Read pid metadata after reload so a stop/uninstall in the window is not resurrected.
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
        // Lock held elsewhere: host was never touched; do not spend budget.
        governor.releaseGrant();
        recoveryPending = true;
        return;
      }
      log.warn("[host-health] auto-recovery attempt failed", err);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? HEALTH_POLL_INTERVAL_MS);
  // Must not keep the Electron main process alive.
  timer.unref();

  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}
