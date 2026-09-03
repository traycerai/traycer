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
});
