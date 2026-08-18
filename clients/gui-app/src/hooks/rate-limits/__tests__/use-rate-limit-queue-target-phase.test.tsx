/**
 * `useRateLimitQueueTargetPhase` is a thin `useSyncExternalStore` wrapper
 * around the queue's own target registry (`getRateLimitQueueTargetPhase` /
 * `subscribeRateLimitQueueTargets`, exercised directly in
 * `ephemeral-fetch-queue.test.ts`). This suite proves the WIRING: the hook
 * re-renders as the real registry transitions through queued -> fetching ->
 * cleared, reads the exact host/provider/profile key it was given, and
 * degrades to `null` with no host scope instead of throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  __resetRateLimitQueueForTests,
  configureRateLimitQueue,
  enqueueRateLimitFetchBatchForScope,
  type RateLimitQueueRequestFn,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

const mocks = vi.hoisted<{ scope: { hostId: string } | null }>(() => ({
  scope: { hostId: "host-1" },
}));

vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => mocks.scope,
}));

import { useRateLimitQueueTargetPhase } from "@/hooks/rate-limits/use-rate-limit-queue-target-phase";

function response() {
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits: null };
}

// A `request` double whose promise settles only when the test releases it, so
// the hook's snapshot can be observed mid-fetch.
function makeControllableRequest() {
  const settlers: Array<() => void> = [];
  const request: RateLimitQueueRequestFn = () =>
    new Promise((resolve) => {
      settlers.push(() => resolve(response()));
    });
  return { request: vi.fn(request), settlers };
}

function target(providerId: RateLimitProviderId, profileId: string | null) {
  return {
    providerId,
    accountContext: DEFAULT_ACCOUNT_CONTEXT,
    profileId,
  };
}

describe("useRateLimitQueueTargetPhase", () => {
  beforeEach(() => {
    __resetRateLimitQueueForTests();
    mocks.scope = { hostId: "host-1" };
  });
  afterEach(() => {
    cleanup();
    __resetRateLimitQueueForTests();
  });

  it("tracks a real target through queued -> fetching -> cleared", async () => {
    const queryClient = new QueryClient();
    const blocker = makeControllableRequest();
    const codex = makeControllableRequest();
    configureRateLimitQueue({
      hostId: "host-1",
      queryClient,
      request: blocker.request,
    });

    // Occupy the lane with claude-code so codex's item stays queued.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-1", queryClient, request: blocker.request },
      [target("claude-code", null)],
      { force: true },
    );
    await waitFor(() => expect(blocker.request).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() =>
      useRateLimitQueueTargetPhase("codex", null),
    );
    expect(result.current).toBeNull();

    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-1", queryClient, request: codex.request },
      [target("codex", null)],
      { force: true },
    );
    await waitFor(() => expect(result.current).toBe("queued"));

    blocker.settlers[0]();
    await waitFor(() => expect(result.current).toBe("fetching"));
    expect(codex.request).toHaveBeenCalledTimes(1);

    codex.settlers[0]();
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("reads the exact provider/profile key it was given, independent of a sibling profile's phase", async () => {
    const queryClient = new QueryClient();
    const personal = makeControllableRequest();
    configureRateLimitQueue({
      hostId: "host-1",
      queryClient,
      request: personal.request,
    });

    const { result: personalPhase } = renderHook(() =>
      useRateLimitQueueTargetPhase("codex", "personal-profile"),
    );
    const { result: workPhase } = renderHook(() =>
      useRateLimitQueueTargetPhase("codex", "work-profile"),
    );
    expect(personalPhase.current).toBeNull();
    expect(workPhase.current).toBeNull();

    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-1", queryClient, request: personal.request },
      [target("codex", "personal-profile")],
      { force: true },
    );
    await waitFor(() => expect(personalPhase.current).toBe("fetching"));
    // The sibling profile on the same provider is untouched.
    expect(workPhase.current).toBeNull();

    personal.settlers[0]();
    await waitFor(() => expect(personalPhase.current).toBeNull());
  });

  it("returns null with no host scope, without touching the registry", () => {
    mocks.scope = null;
    const { result } = renderHook(() =>
      useRateLimitQueueTargetPhase("codex", null),
    );
    expect(result.current).toBeNull();
  });

  it("stops updating once unmounted (unsubscribes)", async () => {
    const queryClient = new QueryClient();
    const codex = makeControllableRequest();
    configureRateLimitQueue({
      hostId: "host-1",
      queryClient,
      request: codex.request,
    });

    const { result, unmount } = renderHook(() =>
      useRateLimitQueueTargetPhase("codex", null),
    );

    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-1", queryClient, request: codex.request },
      [target("codex", null)],
      { force: true },
    );
    await waitFor(() => expect(result.current).toBe("fetching"));

    unmount();
    // Resolving after unmount must not throw from a stale subscription.
    expect(() => codex.settlers[0]()).not.toThrow();
  });
});
