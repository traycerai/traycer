import { randomUUID } from "node:crypto";
import { log } from "../app/logger";
import { hasPendingLoginItemRevision } from "../app/host-login-item";
import { canReachHostWebsocketUrl } from "./host-lifecycle";
import { getActiveEnvironment } from "../ipc/host-management-ipc";
import {
  isPendingRevisionRefreshQuarantined,
  runEnsureHost,
  type HostEnsureIpcResult,
} from "../ipc/host-ensure-ipc";
import type { Environment } from "./host-paths";
import type { RunnerIpcBridge } from "../ipc/runner-ipc-bridge";

// `ensureHost()`'s already-ready fast path only gets a chance to apply a
// deferred LaunchAgent revision (see `host-ensure-ipc.ts:
// applyPendingLoginItemRevisionIfIdle`) once per app launch - the renderer's
// `local-host-gate.tsx` fires `traycerHostEnsure` exactly once per mount,
// gated by a ref that never resets. So a marker left behind because the host
// was busy at that single check sits inert for the rest of the session; the
// user would need to fully relaunch the app before the refreshed plist (e.g.
// the 8,192 descriptor limit) ever takes effect.
//
// This monitor closes that gap: it ticks on a bounded interval and, once it
// observes a pending marker AND a reachable host, hands off to `ensureHost()`
// itself - without ever provisioning a host that isn't already there.
// Recovery of an unreachable host stays owned by the gate/ensure/respawn
// flows; this monitor only ever acts on a host it can already reach. It
// deliberately does NOT duplicate `ensureHost()`'s own removed-by-user or
// host-busy checks - `runEnsure` re-runs both internally (the removed check
// up front, the busy probe inside `applyPendingLoginItemRevisionIfIdle`) at
// identical network cost, so a monitor-side copy would only be dead weight.
//
// Mutual exclusion with a renderer-triggered `ensureHost()` is achieved by
// sharing `host-ensure-ipc.ts`'s own in-flight coalescing slot
// (`runEnsureHost`) rather than re-running `registerHostLoginItem()` /
// `waitForHostReady()` from a second, unguarded call site: whichever caller
// gets there first runs the cycle, the other shares or waits on the result.
// The registration helper also serializes this path with respawn's separate
// in-flight policy, so no caller can overlap the SMAppService mutation itself.

const PENDING_REVISION_POLL_INTERVAL_MS = 30_000;
// A small bound, not a hot-loop backstop: `requires-approval` and other
// terminal SMAppService failures don't resolve themselves by retrying, and a
// host that keeps failing readiness after a register cycle is a Doctor-level
// problem, not something this background monitor should keep hammering.
// After the budget is spent the marker stays on disk for the next `ensure`
// (a later tick will never look again this session) or the next relaunch.
// This budget covers THROWN ensure failures; skips where ensure RESOLVES
// without applying the refresh (requires-approval pre-flight, post-failure
// quarantine) are terminal via the `isRefreshQuarantined` check in `tick`.
const MAX_REFRESH_ATTEMPTS_WITHOUT_SUCCESS = 3;

export interface PendingLoginItemRevisionMonitorDeps {
  readonly bridge: RunnerIpcBridge;
  /** Test seams; production callers pass undefined. */
  readonly intervalMs: number | undefined;
  readonly environment: Environment | undefined;
  readonly hasPendingRevision:
    ((environment: Environment) => Promise<boolean>) | undefined;
  readonly canReach: ((listenUrl: string) => Promise<boolean>) | undefined;
  readonly isRefreshQuarantined: (() => boolean) | undefined;
  readonly runEnsure:
    | ((
        bridge: RunnerIpcBridge,
        operationId: string,
        force: boolean,
      ) => Promise<HostEnsureIpcResult>)
    | undefined;
}

export interface PendingLoginItemRevisionMonitor {
  dispose(): void;
}

export function startPendingLoginItemRevisionMonitor(
  deps: PendingLoginItemRevisionMonitorDeps,
): PendingLoginItemRevisionMonitor {
  const environment = deps.environment ?? getActiveEnvironment();
  const hasPendingRevision =
    deps.hasPendingRevision ?? hasPendingLoginItemRevision;
  const canReach = deps.canReach ?? canReachHostWebsocketUrl;
  const isRefreshQuarantined =
    deps.isRefreshQuarantined ?? isPendingRevisionRefreshQuarantined;
  const runEnsure = deps.runEnsure ?? runEnsureHost;
  let ticking = false;
  let disposed = false;
  let failedAttempts = 0;
  let budgetExhausted = false;

  const tick = async (): Promise<void> => {
    // A tick that outlives its interval must not stack a second concurrent
    // tick on top of it.
    if (ticking || disposed || budgetExhausted) return;
    // Once the ensure fast path has quarantined the refresh for this session
    // (requires-approval pre-flight, or a cycle that ran and did not land
    // enabled), every further handoff would no-op AND resolve successfully -
    // resetting the failure budget below and turning this monitor into a
    // session-long 30s churn loop. Treat the quarantine as terminal instead:
    // stop ticking; the marker survives for the next launch's attempt.
    if (isRefreshQuarantined()) {
      budgetExhausted = true;
      log.info(
        "[pending-login-item-revision-monitor] refresh quarantined for this session - stopping; the marker will be retried at the next launch",
      );
      return;
    }
    ticking = true;
    try {
      // Cheapest check first - no marker means nothing else in this tick is
      // worth doing.
      if (!(await hasPendingRevision(environment))) return;
      if (disposed) return;
      const serviceStatus = await deps.bridge.options.host.getServiceStatus();
      if (disposed) return;
      if (
        serviceStatus.state !== "running" ||
        serviceStatus.listenUrl === null
      ) {
        // Not reachable/installed - recovery belongs to the gate/ensure/
        // respawn flows. This monitor must never spawn the CLI.
        return;
      }
      if (!(await canReach(serviceStatus.listenUrl))) return;
      if (disposed) return;
      log.info(
        "[pending-login-item-revision-monitor] host reachable with a pending LaunchAgent revision - handing off to ensureHost",
      );
      // Shares `host-ensure-ipc.ts`'s in-flight slot - if a renderer-
      // triggered ensure is already running, this either returns its result
      // (non-force) or waits for it to settle rather than racing it.
      await runEnsure(deps.bridge, randomUUID(), false);
      failedAttempts = 0;
    } catch (err) {
      failedAttempts += 1;
      if (failedAttempts >= MAX_REFRESH_ATTEMPTS_WITHOUT_SUCCESS) {
        budgetExhausted = true;
        log.warn(
          "[pending-login-item-revision-monitor] refresh attempt budget exhausted for this session - leaving the marker for the next ensure/relaunch",
          { failedAttempts, err },
        );
      } else {
        log.warn(
          "[pending-login-item-revision-monitor] refresh attempt failed",
          { failedAttempts, err },
        );
      }
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? PENDING_REVISION_POLL_INTERVAL_MS);
  // This monitor must never be what keeps the Electron main process alive.
  timer.unref();

  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}
