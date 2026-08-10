import { describe, expect, it } from "vitest";
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
});
