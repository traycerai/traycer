import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";

/** Captures the options the hook hands the host-query layer. */
const queryMocks = vi.hoisted(() => ({
  options: [] as Array<{ poll?: boolean; staleTime?: number }>,
  refetch: vi.fn(),
  isReady: true,
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

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({
    hostId: "host-1",
    requestContextUserId: "user-1",
    isReady: queryMocks.isReady,
    hasRpcEndpoint: queryMocks.isReady,
    canExecute: queryMocks.isReady,
  }),
}));

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return { ...actual, useHostClient: () => null };
});

const visibilityState = { current: "visible" as DocumentVisibilityState };

describe("useProvidersSkillsList", () => {
  beforeEach(() => {
    queryMocks.options = [];
    queryMocks.refetch.mockClear();
    queryMocks.isReady = true;
    visibilityState.current = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState.current,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(document, "visibilityState");
  });

  /**
   * Assert `poll: false` with `toBe(false)`, not `toBeFalsy()`: the default is `undefined`, which is falsy.
   */
  it("opts out of the table-owned condition poll", () => {
    renderHook(() =>
      useProvidersSkillsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    expect(queryMocks.options.at(0)?.poll).toBe(false);
    expect(queryMocks.options.at(0)?.staleTime).toBe(30_000);
  });

  /** The app's QueryClient sets `refetchOnWindowFocus: false` and `refetchOnReconnect: false`, and the Providers header refresh only targets the classic `{ native: null }` query - so without a cadence of its own an open tab never sees a skill installed or removed from a terminal, and the 30s `staleTime` just marks the cache stale forever. */
  it("refreshes on its own slow cadence instead", () => {
    vi.useFakeTimers();
    renderHook(() =>
      useProvidersSkillsList({
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
      useProvidersSkillsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: false,
      }),
    );

    vi.advanceTimersByTime(120_000);
    expect(queryMocks.refetch).not.toHaveBeenCalled();
  });

  it("does not refresh while the host is not ready", () => {
    queryMocks.isReady = false;
    vi.useFakeTimers();
    renderHook(() =>
      useProvidersSkillsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    vi.advanceTimersByTime(120_000);
    expect(queryMocks.refetch).not.toHaveBeenCalled();
  });

  it("skips ticks while the document is hidden", () => {
    visibilityState.current = "hidden";
    vi.useFakeTimers();
    renderHook(() =>
      useProvidersSkillsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    vi.advanceTimersByTime(60_000);
    expect(queryMocks.refetch).not.toHaveBeenCalled();
  });

  it("clears the cadence on unmount", () => {
    vi.useFakeTimers();
    const rendered = renderHook(() =>
      useProvidersSkillsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    vi.advanceTimersByTime(30_000);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);
    rendered.unmount();
    vi.advanceTimersByTime(60_000);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);
  });
});
