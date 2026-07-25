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
 *
 * ### Unreachable is not dead
 *
 * The endpoint probe answers "is the main thread serving?", which a host that
 * is merely BUSY also fails - opening a large epic blocks it for tens of
 * seconds in one un-yieldable `Y.applyUpdate`. Treating that as death is how
 * v1.1.8-rc.2 killed healthy hosts in a loop. So before this monitor concludes
 * anything from a failed probe it asks whether the process still EXISTS, and
 * an existing process ends the tick: no demote, no respawn, no escalation. The
 * renderer's own WebSocket retry rides the stall out.
 *
 * That check happens BEFORE `reloadSnapshotFromDisk()` on purpose. The reload
 * demotes the snapshot when the endpoint is unreachable, which flips the
 * renderer to its unavailable card and hands recovery ownership to other
 * flows - so checking afterwards would prevent the SIGTERM while still
 * inflicting the outage it exists to avoid.
 *
 * A host that stays unreachable for a very long time is eventually surfaced
 * anyway (`UNREACHABLE_DEMOTE_MS`) so the user has a Retry button, but it is
 * still never auto-killed: deciding to restart a process that is running is
 * the user's call, not this watchdog's.
 */

const HEALTH_POLL_INTERVAL_MS = 15_000;
// Two consecutive failed probes before acting, so one transiently refused
// connect (host mid-GC, socket backlog blip) doesn't trigger a restart.
const CONFIRMED_DOWN_AFTER_FAILURES = 2;
/**
 * How long the endpoint may stay continuously unreachable - with the process
 * demonstrably alive - before the renderer is shown the unavailable card so
 * manual Retry becomes reachable.
 *
 * This escalates the UI only. It deliberately does NOT authorize a kill:
 * "unreachable for a long time" is not "dead", and every automatic restart
 * still has to get past the governor's liveness gate. A genuinely deadlocked
 * host is recovered by the user pressing Retry - an explicit decision, rather
 * than a guess this watchdog makes on their behalf.
 */
const UNREACHABLE_DEMOTE_MS = 600_000;

/**
 * How long to wait before asking again about a host that was already demoted
 * and is demonstrably ALIVE.
 *
 * That state is terminal until something outside this monitor changes it: the
 * process exits, or the user presses Retry. Asking at tick cadence cannot make
 * either happen sooner, and each ask is not free - the liveness probe spawns a
 * child process (`ps` on POSIX, `tasklist` plus `powershell` on Windows), so a
 * wedge lasting an afternoon would spawn thousands of them for an answer that
 * cannot change. Only the `alive` denial waits: a lock-deferred or failed
 * respawn still retries on the very next tick, because those outcomes CAN
 * change on their own.
 *
 * The cost of the wait is bounded and small - a host that dies while wedged is
 * picked up within this window rather than within one tick.
 */
const ALIVE_RECHECK_INTERVAL_MS = 120_000;

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
  /**
   * The single authority for automatic respawns: owns the busy gate and the
   * attempt budget. This monitor asks; it does not decide.
   */
  readonly governor: HostRecoveryGovernor;
  /**
   * Does the published host process still exist? Test seam; production callers
   * pass undefined. Used here only to decide what the USER should see (busy vs
   * unavailable) - the kill decision is the governor's, which checks again
   * itself.
   */
  readonly readLiveness:
    ((pidMetadataFile: string) => Promise<HostProcessLiveness>) | undefined;
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
  const governor = deps.governor;
  const readLiveness = deps.readLiveness ?? readPublishedHostProcessLiveness;
  let consecutiveFailures = 0;
  let recoveryPending = false;
  let ticking = false;
  let disposed = false;
  // Rate-limits the "busy" log to once per stall rather than once per tick, so
  // a long epic open leaves one line instead of dozens.
  let busyLogged = false;
  // When the endpoint first became unreachable in the CURRENT outage. Reset by
  // any reachable observation, so only a continuously unreachable host reaches
  // the demote window.
  let unreachableSince: number | null = null;
  // Earliest tick that may ask the governor again after an `alive` denial. See
  // ALIVE_RECHECK_INTERVAL_MS: this throttles the ONE path that would otherwise
  // re-probe a demoted-but-living host forever.
  let nextRecoveryAttemptAt = 0;

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
    // The governor owns both the liveness gate and the budget; it re-reads
    // pid.json itself so this is a real decision point, not a formality.
    const decision = await governor.requestRespawn("health-monitor");
    if (isDisposed()) return;
    if (decision.kind === "denied") {
      if (decision.reason === "alive") {
        log.info(
          "[host-health] endpoint unresponsive but the host process exists - not respawning",
          { pid: metadata.pid },
        );
        // Stay in recovery ownership: the stall will end, and a later tick's
        // reload converges the snapshot back onto the live host. Nothing this
        // monitor does can shorten the wait, so stop asking at tick cadence -
        // the answer is the user's to change.
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
    // The prior reload demoted the lifecycle snapshot. Retain ownership
    // through this attempt (including a generic failure) until a subsequent
    // reload proves that a host is actually published again.
    recoveryPending = true;
    log.warn(
      "[host-health] endpoint down with live pid metadata - auto-respawning",
      { pid: metadata.pid },
    );
    await respawn();
    if (isDisposed()) return;
    await reloadRecoverySnapshot();
  };

  /**
   * Decides what an unreachable endpoint MEANS, before anything is demoted or
   * restarted. Returns true when the tick should stop here because the host
   * process is alive and merely unresponsive.
   */
  const isBusyRatherThanDown = async (
    snapshot: DesktopLocalHostSnapshot,
    now: number,
  ): Promise<boolean> => {
    const liveness = await readLiveness(deps.host.pidMetadataFile);
    if (isDisposed()) return false;
    if (liveness === "dead") {
      // The process is gone - or its pid was recycled onto something else -
      // so fall through to the existing dead-host handling.
      busyLogged = false;
      return false;
    }
    const unreachableForMs =
      unreachableSince === null ? 0 : now - unreachableSince;
    if (unreachableForMs >= UNREACHABLE_DEMOTE_MS) {
      // Alive, but nothing has answered for a very long time. Let the demote
      // proceed so the renderer offers Retry - and still refuse to kill it
      // here: restarting a running process is the user's call.
      log.warn(
        "[host-health] host process alive but unreachable for a long time - surfacing manual recovery",
        { pid: snapshot.pid, unreachableForMs },
      );
      busyLogged = false;
      return false;
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
          unreachableSince = null;
          return;
        }
        // Throttled only after an `alive` denial (see
        // ALIVE_RECHECK_INTERVAL_MS). Lock-deferred and failed respawns leave
        // this at 0 and so still retry on the next tick.
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
          published.startedAt,
          probe,
        ))
      ) {
        consecutiveFailures = 0;
        busyLogged = false;
        unreachableSince = null;
        // A reachable host is new information, so the next outage is judged
        // immediately rather than serving out a throttle earned by the last one.
        nextRecoveryAttemptAt = 0;
        governor.noteHealthy();
        return;
      }
      // Re-check after every await: dispose() landing during a slow probe
      // or metadata read (app quit) must not let this in-flight tick spawn
      // a host the app is tearing down.
      if (isDisposed()) return;
      governor.noteUnhealthy();
      const now = Date.now();
      if (unreachableSince === null) unreachableSince = now;
      consecutiveFailures += 1;
      if (consecutiveFailures < CONFIRMED_DOWN_AFTER_FAILURES) return;
      consecutiveFailures = 0;

      // Is it dead, or just blocked? Asked BEFORE the reload below, because
      // that reload demotes the snapshot and a busy host must not cost the
      // user their session for the duration of an epic open.
      //
      // Only when pid.json still names THIS host. The liveness answer is about
      // whatever pid.json currently holds, so when disk names a DIFFERENT host
      // - a supervisor respawned it on a new port and the watcher edge was
      // coalesced away, the case the reload below exists for - "alive" is about
      // the replacement, not about the snapshot's process. Treating that as
      // busy would pin the renderer to a dead endpoint for the whole
      // unreachable-demote window instead of converging on the next tick.
      const publishedIsThisHost =
        published !== null &&
        isCurrentPublishedSnapshot(snapshot, published.snapshot);
      if (publishedIsThisHost && (await isBusyRatherThanDown(snapshot, now))) {
        return;
      }
      if (isDisposed()) return;

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
        unreachableSince = null;
        // One reachable observation starts the sustained-health clock; it does
        // not by itself forgive the attempt budget. A freshly spawned host
        // answers exactly one probe before stalling again, and treating that as
        // recovery is what let the original loop re-arm itself forever.
        governor.noteHealthy();
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
        // Another Traycer process held the lock, so the host was never
        // touched: hand the grant back rather than spending budget on a
        // restart that did not happen.
        governor.releaseGrant();
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
