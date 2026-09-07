import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersPluginsList } from "@/hooks/providers/use-providers-plugins-list-query";

/** Captures the options the hook hands the host-query layer. */
const queryMocks = vi.hoisted(() => ({
  options: [] as Array<{ poll?: boolean; staleTime?: number }>,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQueryWithResponseMap: (args: {
    options: { poll?: boolean; staleTime?: number };
  }) => {
    queryMocks.options.push(args.options);
    return {
      data: undefined,
      isPending: true,
      isError: false,
      error: null,
      refetch: queryMocks.refetch,
    };
  },
}));

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return { ...actual, useHostClient: () => null };
});

describe("useProvidersPluginsList", () => {
  beforeEach(() => {
    queryMocks.options = [];
    queryMocks.refetch.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Assert `poll: false` with `toBe(false)`, not `toBeFalsy()`: the default is `undefined`, which is falsy, so the loose form would pass on the omission.
   */
  it("opts out of the table-owned condition poll", () => {
    renderHook(() =>
      useProvidersPluginsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    expect(queryMocks.options.at(0)?.poll).toBe(false);
    expect(queryMocks.options.at(0)?.staleTime).toBe(30_000);
  });

  /** The app's QueryClient sets `refetchOnWindowFocus: false` and `refetchOnReconnect: false`, and the Providers header refresh only targets the classic `{ native: null }` query - so without a cadence of its own an open tab never sees a plugin installed or removed from a terminal, and the 30s `staleTime` just marks the cache stale forever. */
  it("refreshes on its own slow cadence instead", () => {
    vi.useFakeTimers();
    renderHook(() =>
      useProvidersPluginsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    expect(queryMocks.refetch).not.toHaveBeenCalled();
    // Just short of the window: a cadence that fired sooner would be creeping
    // back toward the ~800ms poll this query exists to avoid.
    vi.advanceTimersByTime(29_000);
    expect(queryMocks.refetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);
    // Repeating, not a one-shot.
    vi.advanceTimersByTime(30_000);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(2);
  });

  it("does not refresh while disabled", () => {
    // A disabled query has nothing to refetch, and `refetch()` on one would
    // fire a request the `enabled` gate exists to prevent.
    vi.useFakeTimers();
    renderHook(() =>
      useProvidersPluginsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: false,
      }),
    );

    vi.advanceTimersByTime(120_000);
    expect(queryMocks.refetch).not.toHaveBeenCalled();
  });
});
