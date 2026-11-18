import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onWakeReconnect } from "@/lib/host/wake-reconnect";

describe("onWakeReconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("fires the listener (debounced) when the network comes back online", () => {
    const listener = vi.fn();
    const unsubscribe = onWakeReconnect(listener);

    window.dispatchEvent(new Event("online"));
    // Debounced - not yet.
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("coalesces a burst of online events into a single notification", () => {
    const listener = vi.fn();
    const unsubscribe = onWakeReconnect(listener);

    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(250);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not fire after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onWakeReconnect(listener);
    unsubscribe();

    window.dispatchEvent(new Event("online"));
    vi.advanceTimersByTime(250);

    expect(listener).not.toHaveBeenCalled();
  });
});
