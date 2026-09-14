import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { DesktopProcessMetricsSnapshot } from "@/lib/resources/desktop-app-resource-usage";
import { useDesktopAppResourceUsage } from "@/hooks/resources/use-desktop-app-resource-usage";

/**
 * The sampler this hook subscribes to is a MODULE-LEVEL singleton, owned by
 * `use-desktop-app-resource-usage.ts` itself (one listener set, one interval
 * id, one in-flight flag) - one interval for every surface on screen, never
 * one per component. That singleton is shared across every test in this file
 * too: the interval starts with the first subscriber and stops with the
 * last, so `unmount()` after each render is what actually tears it down. A
 * `getMetrics()` promise left unresolved when a test ends would also leave
 * the in-flight flag stuck for the NEXT test's first sample, so the enabled
 * case below flushes each promise before advancing further.
 */
const bridgeMock = vi.hoisted(() => ({
  getMetrics: vi.fn((): Promise<DesktopProcessMetricsSnapshot> =>
    Promise.resolve({ appMetrics: [] }),
  ),
}));

vi.mock(
  "@/lib/resources/desktop-app-resource-usage",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/resources/desktop-app-resource-usage")
      >();
    return {
      ...actual,
      getDesktopDiagnosticsBridge: () => ({
        getMetrics: bridgeMock.getMetrics,
      }),
    };
  },
);

describe("useDesktopAppResourceUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bridgeMock.getMetrics.mockClear();
    // Restored per test, not just cleared: a case that swaps in its own metrics
    // would otherwise leave them as the next case's first sample.
    bridgeMock.getMetrics.mockResolvedValue({ appMetrics: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts no interval and calls the bridge zero times while disabled, across a full sample period", () => {
    const { result, unmount } = renderHook(() =>
      useDesktopAppResourceUsage(false),
    );

    expect(result.current).toBeNull();

    vi.advanceTimersByTime(5_000);

    expect(bridgeMock.getMetrics).not.toHaveBeenCalled();
    unmount();
  });

  it("samples immediately on subscribe, then once per second while enabled", async () => {
    const { unmount } = renderHook(() => useDesktopAppResourceUsage(true));

    expect(bridgeMock.getMetrics).toHaveBeenCalledTimes(1);
    // Flush the first sample's promise so the in-flight flag clears before the
    // next tick - otherwise the 1s sample below would be silently skipped.
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(bridgeMock.getMetrics).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(bridgeMock.getMetrics).toHaveBeenCalledTimes(3);

    unmount();
  });

  it("drops the snapshot with the last subscriber, so the next one reads null until its own sample lands", async () => {
    bridgeMock.getMetrics.mockResolvedValue({
      appMetrics: [
        {
          pid: 1,
          type: "Browser",
          cpu: { percentCPUUsage: 7 },
          memory: { workingSetSize: 512 * 1024 },
        },
      ],
    });

    const first = renderHook(() => useDesktopAppResourceUsage(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.result.current?.cpuPercent).toBe(7);

    // The interval stops with the last subscriber, so the reading it was
    // refreshing has to stop with it.
    first.unmount();

    const second = renderHook(() => useDesktopAppResourceUsage(true));

    // This is the whole window the fix is about: the new subscriber's own
    // `getMetrics()` is an IPC round trip away, and a retained snapshot would
    // be rendered for the length of it - a figure nothing has refreshed since
    // the last surface closed, with nothing on screen marking it stale.
    expect(second.result.current).toBeNull();

    await vi.advanceTimersByTimeAsync(0);
    expect(second.result.current?.cpuPercent).toBe(7);

    second.unmount();
  });

  it("discards a sample that resolves after the last subscriber left, rather than restoring the cleared snapshot", async () => {
    // The teardown above clears the snapshot; a round trip already in flight
    // defeats that clear by writing the same figure straight back. It is
    // silent - no listener remains to re-render - so it surfaces only when the
    // NEXT subscriber reads the module snapshot synchronously on mount, which
    // is exactly the stale reading the clear exists to prevent.
    let resolveInFlight = (_snapshot: DesktopProcessMetricsSnapshot): void =>
      undefined;
    bridgeMock.getMetrics.mockReturnValueOnce(
      new Promise<DesktopProcessMetricsSnapshot>((resolve) => {
        resolveInFlight = resolve;
      }),
    );

    const first = renderHook(() => useDesktopAppResourceUsage(true));
    expect(bridgeMock.getMetrics).toHaveBeenCalledTimes(1);

    // The last subscriber leaves within one IPC round trip of that sample.
    first.unmount();

    resolveInFlight({
      appMetrics: [
        {
          pid: 1,
          type: "Browser",
          cpu: { percentCPUUsage: 7 },
          memory: { workingSetSize: 512 * 1024 },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);

    const second = renderHook(() => useDesktopAppResourceUsage(true));
    expect(second.result.current).toBeNull();

    // And the sampler is not left broken by the discard: this subscriber's own
    // sample lands normally.
    await vi.advanceTimersByTimeAsync(0);
    expect(second.result.current).not.toBeNull();

    second.unmount();
  });
});
