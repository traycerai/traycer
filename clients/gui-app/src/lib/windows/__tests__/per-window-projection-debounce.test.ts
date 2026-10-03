import { describe, expect, it, vi } from "vitest";
import { createDebouncedDesktopPerWindowProjectionBridge } from "@/lib/windows/per-window-projection-debounce";
import type { DesktopPerWindowStatePatch } from "@/lib/windows/types";

/**
 * The debounce interval is parked far past the test so only the explicit
 * `flush()` calls drive the write chain; each test disposes the bridge to drop
 * the trailing timer.
 */
const NEVER_FIRES_MS = 60_000;

function failingOnceTarget(): {
  readonly update: (patch: DesktopPerWindowStatePatch) => Promise<unknown>;
  readonly attempts: readonly DesktopPerWindowStatePatch[];
} {
  const attempts: DesktopPerWindowStatePatch[] = [];
  let failNext = true;
  return {
    attempts,
    update: (patch) => {
      attempts.push(patch);
      if (!failNext) return Promise.resolve();
      failNext = false;
      return Promise.reject(new Error("projection failed"));
    },
  };
}

describe("createDebouncedDesktopPerWindowProjectionBridge", () => {
  it("keeps projecting after a failed write instead of wedging the queue", async () => {
    const target = failingOnceTarget();
    const bridge = createDebouncedDesktopPerWindowProjectionBridge(
      target,
      NEVER_FIRES_MS,
    );

    await bridge.update({ activeTabId: "tab-a" });
    await expect(bridge.flush()).rejects.toThrow("projection failed");

    // Without recovering the chain the rejected promise is what the next patch
    // chains off, so `target.update` is never reached again for the rest of the
    // session and the window silently stops persisting.
    await bridge.update({ activeTabId: "tab-b" });
    await expect(bridge.flush()).resolves.toBeUndefined();

    expect(target.attempts).toEqual([
      { activeTabId: "tab-a" },
      { activeTabId: "tab-b" },
    ]);
    bridge.dispose();
  });

  it("reports the failure to the caller that flushed it", async () => {
    const target = failingOnceTarget();
    const bridge = createDebouncedDesktopPerWindowProjectionBridge(
      target,
      NEVER_FIRES_MS,
    );

    await bridge.update({ activeTabId: "tab-a" });
    await expect(bridge.flush()).rejects.toThrow("projection failed");

    // A flush with nothing pending settles on the recovered chain rather than
    // re-raising an already-reported failure.
    await expect(bridge.flush()).resolves.toBeUndefined();
    bridge.dispose();
  });

  it("schedule() keeps only the latest callback and invokes it exactly once, at flush", async () => {
    const target = { update: vi.fn(() => Promise.resolve()) };
    const bridge = createDebouncedDesktopPerWindowProjectionBridge(
      target,
      NEVER_FIRES_MS,
    );

    const stale1 = vi.fn(() => ({ activeTabId: "stale-1" }));
    const stale2 = vi.fn(() => ({ activeTabId: "stale-2" }));
    const latest = vi.fn(() => ({ activeTabId: "latest" }));

    bridge.schedule(stale1);
    bridge.schedule(stale2);
    bridge.schedule(latest);

    // A burst of `schedule()` calls must not build every intermediate
    // projection - only the winning callback is ever invoked, and only once,
    // at flush time.
    expect(stale1).not.toHaveBeenCalled();
    expect(stale2).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();

    await bridge.flush();

    expect(stale1).not.toHaveBeenCalled();
    expect(stale2).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(target.update).toHaveBeenCalledTimes(1);
    expect(target.update).toHaveBeenCalledWith({ activeTabId: "latest" });

    bridge.dispose();
  });

  it("captures the scheduled projection synchronously at flush, even while an earlier write is still in flight", async () => {
    // The write-chain barrier: a caller (a move/close guard) that calls
    // `flush()` must get back a snapshot of what was pending AT THAT CALL,
    // not one that waits for an older in-flight IPC write to settle first.
    const firstWrite: { resolve: (() => void) | null } = { resolve: null };
    const attempts: DesktopPerWindowStatePatch[] = [];
    const target = {
      update: (patch: DesktopPerWindowStatePatch) => {
        attempts.push(patch);
        if (attempts.length === 1) {
          return new Promise<void>((resolve) => {
            firstWrite.resolve = resolve;
          });
        }
        return Promise.resolve();
      },
    };
    const bridge = createDebouncedDesktopPerWindowProjectionBridge(
      target,
      NEVER_FIRES_MS,
    );

    bridge.schedule(() => ({ activeTabId: "first" }));
    const firstFlush = bridge.flush();
    // Let the write chain actually reach `target.update` for the first patch
    // (a macrotask tick fully drains the microtask queue), so it is genuinely
    // in flight - unresolved - before the second flush below.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(attempts).toEqual([{ activeTabId: "first" }]);

    const secondProjection = vi.fn(() => ({ activeTabId: "second" }));
    bridge.schedule(secondProjection);
    const secondFlushPromise = bridge.flush();

    // Materialization is synchronous: the second flush call has already
    // invoked its projection and queued the write behind the first, without
    // waiting for the first write to settle.
    expect(secondProjection).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([{ activeTabId: "first" }]);

    firstWrite.resolve?.();
    await firstFlush;
    await secondFlushPromise;

    expect(attempts).toEqual([
      { activeTabId: "first" },
      { activeTabId: "second" },
    ]);

    bridge.dispose();
  });
});
