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

/**
 * Steady-state watchdog for the CLI-owned host. Runs on every platform (see
 * `desktop-startup.ts`); auto-respawn has historically mattered most on
 * Windows, while the snapshot-convergence duty matters everywhere.
 *
 * This comment used to justify the Windows gap with "the Scheduled Task cannot
 * restart-on-failure (its hidden-launcher action detaches the host and exits,
 * so the job 'completed' long before the host can die)". That was FALSE, and
 * saying so here is worth the lines because it was the stated reason nobody
 * pursued the gap: `traycer host start` spawns the host with no `detached` and
 * no `unref()` (it must stay attached to tee the child's stderr), and the VBS
 * launcher uses `shell.Run(..., True)`, which waits. The chain therefore lives
 * as long as the host and exits with the host's own code - a crashed host DID
 * surface to Task Scheduler as a failed run, and it still was not restarted.
 *
 * The supervisor now relaunches its own child on any non-clean exit
 * (`MAX_CONSECUTIVE_RELAUNCHES` in `commands/host-start.ts`, int #4826), which
 * covers the case this monitor structurally cannot: a crash while the desktop
 * app is CLOSED, when nothing here is running to notice. The two layers do not
 * fight - the supervisor is faster, so a later tick's `reloadSnapshotFromDisk`
 * simply converges onto the replacement, and any respawn this monitor does
 * request goes through `traycer host restart`, which announces stop intent and
 * so suppresses the supervisor's own relaunch.
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
 * That shield used to expire: after `UNREACHABLE_DEMOTE_MS` the monitor let the
 * demote through so the renderer would offer a Retry button. It no longer does,
 * and the deletion is the point of int #48. A demote is the renderer being told
 * the host is GONE, and on 2026-08-11 that verdict locked every chat on a
 * healthy staging machine read-only for two hours while the same host answered
 * renderer RPCs in milliseconds. "Unreachable for a long time" is still not
 * "dead", and a live host is now reported as `busy` for as long as it stays
 * live - a degraded badge, not a tombstone. Restarting a wedged host remains
 * the user's call and remains reachable, through Settings -> Host rather than
 * through a card this watchdog fabricates by lying about liveness.
 */

const HEALTH_POLL_INTERVAL_MS = 15_000;
// Two consecutive failed probes before acting, so one transiently refused
// connect (host mid-GC, socket backlog blip) doesn't trigger a restart.
const CONFIRMED_DOWN_AFTER_FAILURES = 2;
/**
 * How long the endpoint may stay continuously unreachable - with the process
 * demonstrably alive - before this monitor says so at WARN.
 *
 * Diagnostics only. It used to gate a demote (show the renderer the
 * unavailable card so manual Retry became reachable); int #48 removed that,
 * because a demote asserts the host is gone and a process we just proved is
 * alive is not gone. The line stays because "alive but silent for ten minutes"
 * is genuinely worth finding in a support report - it is the signature of a
 * real deadlock, as opposed to the epic-open stall this shield exists for.
 */
const UNREACHABLE_WARN_MS = 600_000;

/**
 * How long to wait before asking the OS again about a host that is
 * demonstrably ALIVE and not answering.
 *
 * Each ask is not free: the liveness probe spawns a child process (`ps` on
 * POSIX, `tasklist` plus `powershell` on Windows). Since int #48 the busy hold
 * no longer expires, so a wedge lasting an afternoon would otherwise spawn one
 * every other tick, indefinitely, for an answer that changes at most once.
 *
 * Two paths share the interval: the `alive` respawn denial, and the busy
 * shield's own liveness re-read. Only those two wait - a lock-deferred or
 * failed respawn still retries on the very next tick, because those outcomes
 * CAN change on their own, and any reachable observation clears the throttle
 * so a fresh outage is judged on fresh evidence.
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
  // Production needs the published start identity for A1's process-identity
  // check. Existing test callers can continue supplying a structural reader;
  // a missing identity deliberately falls through A1's indeterminate arm.
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
  // Rate-limits the "busy" log to once per stall rather than once per tick, so
  // a long epic open leaves one line instead of dozens.
  let busyLogged = false;
  // Same once-per-stall rate limit as `busyLogged`, for the long-stall WARN.
  let longStallLogged = false;
  // When the endpoint first became unreachable in the CURRENT outage. Reset by
  // any reachable observation, so only a continuously unreachable host reaches
  // the demote window.
  let unreachableSince: number | null = null;
  // Earliest tick that may ask the governor again after an `alive` denial. See
  // ALIVE_RECHECK_INTERVAL_MS: this throttles the ONE path that would otherwise
  // re-probe a demoted-but-living host forever.
  let nextRecoveryAttemptAt = 0;
  // Earliest tick that may re-ask the OS whether a held-busy host still
  // exists. See ALIVE_RECHECK_INTERVAL_MS: the hold is now unbounded in time,
  // so without this the shield would spawn a `ps` (or `tasklist` +
  // `powershell`) every other tick for as long as the stall lasts.
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
    const unreachableForMs =
      unreachableSince === null ? 0 : now - unreachableSince;
    // The throttle arms only in the LONG-stall regime - the same boundary the
    // demote used to sit on. Before it, a dying host is still checked every
    // pass, because that is the window where a stall most often turns out to
    // be a death and prompt detection is what keeps `absent` honest. After it,
    // the answer has been the same for ten minutes and each re-ask spawns a
    // child process, so it coasts and picks up a death within one interval.
    const longStall = unreachableForMs >= UNREACHABLE_WARN_MS;
    if (longStall && now < nextLivenessCheckAt) {
      return true;
    }
    const liveness = await readLiveness(deps.host.pidMetadataFile);
    if (isDisposed()) return false;
    if (liveness === "dead") {
      nextLivenessCheckAt = 0;
      // The process is gone - or its pid was recycled onto something else -
      // so fall through to the existing dead-host handling.
      busyLogged = false;
      longStallLogged = false;
      return false;
    }
    if (longStall) {
      nextLivenessCheckAt = now + ALIVE_RECHECK_INTERVAL_MS;
    }
    if (longStall && !longStallLogged) {
      // Alive, but nothing has answered for a very long time. Say so loudly -
      // and then keep holding. This arm used to `return false`, letting the
      // reload demote the snapshot; that is the 2026-08-11 outage, and the
      // liveness answer we just read is the reason it is wrong.
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
          // Not idle: converge. A null snapshot with nothing scheduled to
          // re-examine it is the exact shape of the two-hour 2026-08-11 wedge -
          // the pid-file watcher is edge-triggered on WRITES, so a host that
          // is already up and simply never rewrites pid.json produces no edge
          // and nothing else here would ever look again. This is a read-only
          // disk re-read plus a probe; it starts nothing and kills nothing, so
          // recovery OWNERSHIP still belongs to the flows this branch defers
          // to. Bounded at the tick cadence and cheap when there is no host
          // (one ENOENT read).
          await deps.host.reloadSnapshotFromDisk();
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
          published.startIdentity,
          probe,
        ))
      ) {
        consecutiveFailures = 0;
        busyLogged = false;
        longStallLogged = false;
        unreachableSince = null;
        // The endpoint answered. Hand that straight to the lifecycle, which
        // owns the renderer-facing verdict and may still be publishing `busy`
        // from an earlier stall. On 2026-08-11 probes like this one succeeded
        // for two hours while the renderer was never told - nothing carried
        // the good news across. This is that edge; it no-ops once the verdict
        // is already `available`.
        deps.host.noteEndpointAnswered();
        // A reachable host is new information, so the next outage is judged
        // immediately rather than serving out a throttle earned by the last one.
        nextRecoveryAttemptAt = 0;
        // A reachable host is new information: the next outage gets a fresh
        // liveness read rather than coasting on a throttle the last one earned.
        nextLivenessCheckAt = 0;
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
        // Convergence ends the current stall just as a direct reachable probe
        // does, so the once-per-stall log latches and the liveness-read
        // throttle reset with it. Without this, a host that answers exactly
        // one probe (this reload's) and then stalls again would serve its next
        // long stall silently - the WARN latched by the previous outage never
        // cleared.
        busyLogged = false;
        longStallLogged = false;
        nextLivenessCheckAt = 0;
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
