import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import {
  __resetDocumentVisibilitySubscribersForTests,
  setDesktopWindowOnScreen,
} from "@/lib/dom/document-visibility";

/**
 * Captures only `refetch` - the pending-poll cadence is invisible from the
 * MCP tab, which mocks this hook wholesale in its own tests.
 */
const queryMocks = vi.hoisted(() => ({
  refetch: vi.fn(() => Promise.resolve()),
}));

const readinessMocks = vi.hoisted(() => ({ isReady: true }));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQueryWithResponseMap: () => ({
    data: { servers: [] },
    isPending: false,
    isError: false,
    error: null,
    refetch: queryMocks.refetch,
  }),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: () => ({ isReady: readinessMocks.isReady }),
}));

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return { ...actual, useHostClient: () => null };
});

function renderPolling(): void {
  renderHook(() =>
    useProvidersMcpList({
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
      enabled: true,
      pollWhilePending: true,
    }),
  );
}

function defineVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("useProvidersMcpList pending-poll gating", () => {
  beforeEach(() => {
    queryMocks.refetch.mockClear();
    readinessMocks.isReady = true;
    defineVisibility("visible");
    setDesktopWindowOnScreen(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetDocumentVisibilitySubscribersForTests();
  });

  it("polls with cancelRefetch:false once ready and visible", () => {
    vi.useFakeTimers();
    renderPolling();

    vi.advanceTimersByTime(800);

    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);
    expect(queryMocks.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it("never polls while the host is not reactively ready", () => {
    vi.useFakeTimers();
    readinessMocks.isReady = false;
    renderPolling();

    vi.advanceTimersByTime(60_000);

    expect(queryMocks.refetch).not.toHaveBeenCalled();
  });

  it("never polls while the document starts hidden", () => {
    vi.useFakeTimers();
    defineVisibility("hidden");
    renderPolling();

    vi.advanceTimersByTime(60_000);

    expect(queryMocks.refetch).not.toHaveBeenCalled();
  });

  it("stops polling once the desktop window goes off-screen, and resumes on return", async () => {
    vi.useFakeTimers();
    renderPolling();
    vi.advanceTimersByTime(800);
    // Let the first poll's `await refetch(...)` settle before it re-arms the
    // next schedule - otherwise the visibility flip below lands mid-refresh.
    await Promise.resolve();
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);

    setDesktopWindowOnScreen(false);
    vi.advanceTimersByTime(60_000);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);

    // Returning to the foreground immediately refreshes rather than waiting
    // out whatever backoff delay had accumulated.
    setDesktopWindowOnScreen(true);
    await Promise.resolve();
    expect(queryMocks.refetch).toHaveBeenCalledTimes(2);
  });

  it("does not overlap the next poll while a read is unresolved, backs off once it settles, and disarms when pollWhilePending turns off", async () => {
    vi.useFakeTimers();
    const refetchDeferred: { resolve: (() => void) | null } = {
      resolve: null,
    };
    function resolveRefetch(): void {
      if (refetchDeferred.resolve === null) {
        throw new Error("expected a pending refetch to resolve");
      }
      refetchDeferred.resolve();
      refetchDeferred.resolve = null;
    }
    queryMocks.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          refetchDeferred.resolve = resolve;
        }),
    );

    const { rerender } = renderHook(
      (props: { pollWhilePending: boolean }) =>
        useProvidersMcpList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
          pollWhilePending: props.pollWhilePending,
        }),
      { initialProps: { pollWhilePending: true } },
    );

    vi.advanceTimersByTime(800);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);

    // The first read is still unresolved: the next schedule only runs once
    // this one settles, so waiting out even the full 30s cap fires nothing.
    vi.advanceTimersByTime(30_000);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);

    // Once it settles, the chain reschedules at the DOUBLED delay (1600ms) -
    // it does not repeat the initial 800ms.
    resolveRefetch();
    await Promise.resolve();
    vi.advanceTimersByTime(800);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(800);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(2);

    // Settle the second read, then turn `pollWhilePending` off - the pending
    // timer this armed for the (now-cancelled) next poll must be cleared, so
    // nothing fires even after a long wait.
    resolveRefetch();
    await Promise.resolve();
    rerender({ pollWhilePending: false });
    vi.advanceTimersByTime(60_000);
    expect(queryMocks.refetch).toHaveBeenCalledTimes(2);
  });
});
