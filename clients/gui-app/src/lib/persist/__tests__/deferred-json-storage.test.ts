import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "@/lib/logger";
import {
  cancelDeferredJsonWrites,
  deferJsonWrite,
  persistNowOrThrow,
} from "../deferred-json-storage";

const DEBOUNCE_MS = 100;
const MAX_WAIT_MS = 1000;

describe("deferred-json-storage", () => {
  beforeEach(() => {
    // Date is faked too: the maxWait test below measures true elapsed
    // simulated time, not a step-loop's coarser iteration count.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    cancelDeferredJsonWrites();
  });

  afterEach(() => {
    cancelDeferredJsonWrites();
    vi.useRealTimers();
    // A negative-control run that fails mid-test (e.g. at an assertion
    // before a spy would otherwise be restored) must not leak that spy into
    // the next test.
    vi.restoreAllMocks();
  });

  it("continuous re-scheduling for 3s still flushes within the 1s maxWait ceiling, not just once typing stops", () => {
    const key = "continuous-typing-key";
    const start = Date.now();
    let flushedAtMs: number | null = null;
    const write = vi.fn(() => {
      flushedAtMs ??= Date.now() - start;
    });
    for (let elapsed = 0; elapsed < 3000; elapsed += 80) {
      // Every call is well inside the ordinary 100ms debounce window, so
      // that alone would never fire while this loop keeps running.
      deferJsonWrite(key, write);
      vi.advanceTimersByTime(80);
    }
    expect(write).toHaveBeenCalled();
    expect(flushedAtMs).not.toBeNull();
    expect(flushedAtMs).toBeLessThanOrEqual(MAX_WAIT_MS);
  });

  it("a failed deferred write is retained (not dropped) and a later lifecycle flush retries and lands it, logging the key only", () => {
    const key = "retry-key";
    let attempt = 0;
    const write = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("simulated quota failure with secret content inside");
      }
    });
    const warnSpy = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);
    deferJsonWrite(key, write);

    // The debounce fires; the write throws, is caught, and retained.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(write).toHaveBeenCalledTimes(1);

    // A lifecycle flush (pagehide) retries the SAME still-pending callback,
    // which now succeeds. This is the primary claim - checked before the log
    // shape below, so a shape mismatch never masks a retention failure.
    window.dispatchEvent(new Event("pagehide"));
    expect(write).toHaveBeenCalledTimes(2);

    // Nothing left pending: the next debounce window finds nothing to do.
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(write).toHaveBeenCalledTimes(2);

    // The one failed attempt logged the key only - never the error/content.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[persist] deferred local write failed",
      { key },
    );
  });

  it("persistNowOrThrow throws on a failing write, retains it for a retry, and clears it once it succeeds", () => {
    const key = "barrier-key";
    let attempt = 0;
    const write = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("simulated failure");
    });
    deferJsonWrite(key, write);

    expect(() => persistNowOrThrow(key)).toThrow("simulated failure");
    expect(write).toHaveBeenCalledTimes(1);

    // Retained, not dropped - a second call retries the SAME callback.
    expect(() => persistNowOrThrow(key)).not.toThrow();
    expect(write).toHaveBeenCalledTimes(2);

    // And it is now actually cleared: a third call finds nothing pending.
    persistNowOrThrow(key);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
