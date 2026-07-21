import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPendingLoginItemRevisionMonitor } from "../pending-login-item-revision-monitor";
import type { PendingLoginItemRevisionMonitorHostController } from "../pending-login-item-revision-monitor";
import type { MutationOutcome } from "../host-controller-types";
import type { ConvergeReadyOk } from "../host-controller-types";

// Ticket: HostController two-lane scheduler cutover. This monitor used to
// own the pending-LaunchAgent-revision fast path's own guards (marker check,
// reachability, idle probe) and hand off to `host-ensure-ipc.ts`'s
// `runEnsureHost` in-flight slot. All of that now lives inside
// `HostController.applyPendingLoginItemRevisionIfIdle()` - a single,
// self-locking controller method - so this monitor is a thin timer wrapper:
// it owns only the poll interval, the failure budget, and stopping once the
// controller reports the refresh quarantined for the session. See
// `host-controller.test.ts` for the actual refresh-cycle behavior (busy
// skip, requires-approval quarantine, desktop-lock mutual exclusion with a
// concurrent `convergeReady`) and `pending-login-item-revision-monitor.ts`'s
// module doc comment for the full mechanism this closes the gap for.

const SERVICE_VERSION = "1.2.3";
const INTERVAL_MS = 1_000;

type Outcome = MutationOutcome<ConvergeReadyOk> | null;

function fakeHostController(
  applyPendingLoginItemRevisionIfIdle: () => Promise<Outcome>,
  isPendingRevisionRefreshQuarantined: () => boolean,
): PendingLoginItemRevisionMonitorHostController {
  return {
    applyPendingLoginItemRevisionIfIdle,
    isPendingRevisionRefreshQuarantined,
  };
}

describe("startPendingLoginItemRevisionMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function ticks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
  }

  // Fixup D2: title narrowed - every outcome here is "ok", so there is never
  // a spent failure budget for this test to reset. The reset-on-success
  // claim is actually exercised (failure -> success -> failure again all
  // still running) by the test below, "resets the failure budget after a
  // successful refresh".
  it("calls applyPendingLoginItemRevisionIfIdle on every tick", async () => {
    const refresh = vi.fn(async (): Promise<Outcome> => ({
      kind: "ok",
      value: { running: true, version: SERVICE_VERSION },
    }));
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, () => false),
      intervalMs: INTERVAL_MS,
    });
    await ticks(3);
    expect(refresh).toHaveBeenCalledTimes(3);
    monitor.dispose();
  });

  it("treats a null outcome (nothing to do) as a no-op that does not spend the failure budget", async () => {
    const refresh = vi.fn(async (): Promise<Outcome> => null);
    const isQuarantined = vi.fn(() => false);
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, isQuarantined),
      intervalMs: INTERVAL_MS,
    });
    await ticks(10);
    expect(refresh).toHaveBeenCalledTimes(10);
    // Never quarantined by the controller and null is never a failure, so
    // ticking never stops on its own.
    monitor.dispose();
  });

  it("exhausts the failure budget after 3 non-ok outcomes and stops every check thereafter, permanently", async () => {
    const refresh = vi.fn(async (): Promise<Outcome> => ({
      kind: "failed",
      message: "refresh cycle failed",
    }));
    const isQuarantined = vi.fn(() => false);
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, isQuarantined),
      intervalMs: INTERVAL_MS,
    });

    await ticks(3);
    expect(refresh).toHaveBeenCalledTimes(3);

    refresh.mockClear();
    isQuarantined.mockClear();

    // 4th tick: budget already exhausted - not even the quarantine check
    // (which itself gates every tick) should keep calling refresh.
    await ticks(3);
    expect(refresh).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it("increments the failure budget on a thrown refresh, same as a non-ok outcome", async () => {
    const refresh = vi.fn(async (): Promise<Outcome> => {
      throw new Error("refresh threw");
    });
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, () => false),
      intervalMs: INTERVAL_MS,
    });

    await ticks(3);
    expect(refresh).toHaveBeenCalledTimes(3);
    refresh.mockClear();

    await ticks(1);
    expect(refresh).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it("resets the failure budget after a successful refresh", async () => {
    let shouldFail = true;
    const refresh = vi.fn(async (): Promise<Outcome> => {
      if (shouldFail) throw new Error("refresh failed");
      return { kind: "ok", value: { running: true, version: SERVICE_VERSION } };
    });
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, () => false),
      intervalMs: INTERVAL_MS,
    });

    await ticks(2); // 2 failures - budget not yet exhausted (threshold is 3)
    shouldFail = false;
    await ticks(1); // success resets failedAttempts to 0
    shouldFail = true;
    await ticks(3); // a fresh run of 3 failures - should still be allowed to run all 3
    expect(refresh).toHaveBeenCalledTimes(6);

    monitor.dispose();
  });

  it("stops for the session the moment the controller reports the refresh quarantined - no further calls, even without a thrown/failed outcome", async () => {
    // Without this terminal check, a quarantined controller state would just
    // make every tick call `applyPendingLoginItemRevisionIfIdle()` forever
    // for a refresh that can never succeed again this session.
    let quarantined = false;
    const refresh = vi.fn(async (): Promise<Outcome> => {
      quarantined = true;
      return null;
    });
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, () => quarantined),
      intervalMs: INTERVAL_MS,
    });

    await ticks(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    refresh.mockClear();
    await ticks(4);
    expect(refresh).not.toHaveBeenCalled();

    monitor.dispose();
  });

  it("checks the quarantine flag before every tick's refresh call, not only once at start", async () => {
    const refresh = vi.fn(async (): Promise<Outcome> => null);
    const isQuarantined = vi.fn(() => false);
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, isQuarantined),
      intervalMs: INTERVAL_MS,
    });
    await ticks(5);
    expect(isQuarantined).toHaveBeenCalledTimes(5);
    monitor.dispose();
  });

  it("disposing mid-tick stops further ticks and does not crash once the in-flight call resolves", async () => {
    let resolveRefresh!: (value: Outcome) => void;
    const pending = new Promise<Outcome>((resolve) => {
      resolveRefresh = resolve;
    });
    const refresh = vi.fn(() => pending);
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, () => false),
      intervalMs: INTERVAL_MS,
    });

    // Fires tick 1, which suspends on the still-pending refresh call.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    monitor.dispose();
    resolveRefresh({
      kind: "ok",
      value: { running: true, version: SERVICE_VERSION },
    });
    // Flush the suspended tick's continuation after resolution.
    await Promise.resolve();
    await Promise.resolve();

    // No further ticks fire - the interval was cleared by dispose().
    await ticks(3);
    expect(refresh).toHaveBeenCalledTimes(1);

    // dispose() is idempotent and does not crash when called again.
    expect(() => monitor.dispose()).not.toThrow();
  });

  it("does not stack a second tick on top of a still-pending one", async () => {
    let resolveRefresh!: (value: Outcome) => void;
    let callCount = 0;
    const refresh = vi.fn(() => {
      callCount += 1;
      return new Promise<Outcome>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    const monitor = startPendingLoginItemRevisionMonitor({
      hostController: fakeHostController(refresh, () => false),
      intervalMs: INTERVAL_MS,
    });

    // Two interval fires while the first call is still pending.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(callCount).toBe(1);

    resolveRefresh({
      kind: "ok",
      value: { running: true, version: SERVICE_VERSION },
    });
    await Promise.resolve();
    await Promise.resolve();

    monitor.dispose();
  });
});
