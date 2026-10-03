import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersPluginsList } from "@/hooks/providers/use-providers-plugins-list-query";
import {
  __resetDocumentVisibilitySubscribersForTests,
  setDesktopWindowOnScreen,
} from "@/lib/dom/document-visibility";

/**
 * Captures the options the hook hands the host-query layer. `poll` is the only
 * thing under test here and it is invisible from the plugins tab, which mocks
 * this hook wholesale.
 */
const queryMocks = vi.hoisted(() => ({
  options: [] as Array<{ poll?: boolean; staleTime?: number }>,
  refetch: vi.fn(),
}));

const readinessMocks = vi.hoisted(() => ({ isReady: true }));

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
  useReactiveHostReadiness: () => ({ isReady: readinessMocks.isReady }),
}));

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return { ...actual, useHostClient: () => null };
});

function defineVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("useProvidersPluginsList", () => {
  beforeEach(() => {
    queryMocks.options = [];
    queryMocks.refetch.mockClear();
    readinessMocks.isReady = true;
    defineVisibility("visible");
    setDesktopWindowOnScreen(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetDocumentVisibilitySubscribersForTests();
  });

  /**
   * `providers.list` is a CONDITION-POLLED method, and condition queries join
   * the table-owned poll by default - `refetchInterval` fires regardless of
   * `staleTime`, so the 30s stale window below is not a substitute and cannot
   * stand in for this. On Codex each list spawns `codex plugin list --json` for
   * the enabled flags, so an inherited ~800ms cadence launches a CLI process
   * per tick for as long as the tab is open.
   *
   * Asserted as `toBe(false)` rather than `toBeFalsy()`: the default is
   * `undefined`, which is falsy, so the loose form would pass on exactly the
   * omission this pins.
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

  /**
   * Declining the table poll removed the last thing that refetched this query.
   * The app's QueryClient sets `refetchOnWindowFocus: false` and
   * `refetchOnReconnect: false`, and the Providers header refresh only targets
   * the classic `{ native: null }` query - so without a cadence of its own an
   * open tab never sees a plugin installed or removed from a terminal, and the
   * 30s `staleTime` just marks the cache stale forever.
   */
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

  it("refreshes with cancelRefetch:false so a slow read is not cancelled by the next tick", () => {
    vi.useFakeTimers();
    renderHook(() =>
      useProvidersPluginsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    vi.advanceTimersByTime(30_000);
    expect(queryMocks.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it("never polls while the host is not reactively ready", () => {
    vi.useFakeTimers();
    readinessMocks.isReady = false;
    renderHook(() =>
      useProvidersPluginsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    vi.advanceTimersByTime(120_000);
    expect(queryMocks.refetch).not.toHaveBeenCalled();
  });

  it("never polls while the document starts hidden", () => {
    vi.useFakeTimers();
    defineVisibility("hidden");
    renderHook(() =>
      useProvidersPluginsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    vi.advanceTimersByTime(120_000);
    expect(queryMocks.refetch).not.toHaveBeenCalled();
  });

  it("stops polling once the desktop window goes off-screen, and resumes on return", async () => {
    vi.useFakeTimers();
    renderHook(() =>
      useProvidersPluginsList({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        enabled: true,
      }),
    );

    vi.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);

    setDesktopWindowOnScreen(false);
    vi.advanceTimersByTime(120_000);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);

    // Returning to the foreground immediately refreshes rather than waiting
    // out the rest of the 30s cadence.
    setDesktopWindowOnScreen(true);
    await Promise.resolve();
    expect(queryMocks.refetch).toHaveBeenCalledTimes(2);
  });
});
