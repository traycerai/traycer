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
  getRateLimitQueueTargetPhase,
  type RateLimitQueueRequestFn,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

const mocks = vi.hoisted<{ scope: { hostId: string } | null }>(() => ({
  scope: { hostId: "host-1" },
}));

vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => mocks.scope,
}));

import {
  useAnyRateLimitQueueTargetFetching,
  useIsRateLimitQueueTargetForced,
  useRateLimitQueueTargetPhase,
} from "@/hooks/rate-limits/use-rate-limit-queue-target-phase";

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

/**
 * The fold memoizes its target list on a serialized key. These pin that the
 * key preserves target IDENTITY for ids a delimiter join would corrupt: a
 * profile id is a free-form string off the provider, so `""` must stay
 * distinct from `null` (follow the default profile) and an id may contain any
 * character - including whatever would otherwise separate the pairs. Getting
 * this wrong reads the WRONG queue entry, so a control reports idle while its
 * real target is mid-subprocess: the exact failure this hook exists to stop.
 */
describe("useAnyRateLimitQueueTargetFetching target identity", () => {
  beforeEach(() => {
    __resetRateLimitQueueForTests();
    mocks.scope = { hostId: "host-1" };
  });
  afterEach(() => {
    cleanup();
    __resetRateLimitQueueForTests();
  });

  it("does not confuse an EMPTY-string profile id with the null default profile", async () => {
    const queryClient = new QueryClient();
    const fetching = makeControllableRequest();
    configureRateLimitQueue({
      hostId: "host-1",
      queryClient,
      request: fetching.request,
    });

    // Only the EMPTY-STRING profile is in flight.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-1", queryClient, request: fetching.request },
      [target("codex", "")],
      { force: true },
    );
    await waitFor(() => expect(fetching.request).toHaveBeenCalledTimes(1));

    const empty = renderHook(() =>
      useAnyRateLimitQueueTargetFetching([
        { providerId: "codex", profileId: "" },
      ]),
    );
    const nullDefault = renderHook(() =>
      useAnyRateLimitQueueTargetFetching([
        { providerId: "codex", profileId: null },
      ]),
    );

    await waitFor(() => expect(empty.result.current).toBe(true));
    expect(nullDefault.result.current).toBe(false);
  });

  it("keeps pairs aligned when a profile id contains the character that separates them", async () => {
    const queryClient = new QueryClient();
    const fetching = makeControllableRequest();
    configureRateLimitQueue({
      hostId: "host-1",
      queryClient,
      request: fetching.request,
    });

    // A NUL inside the id: a delimiter join would split here and shift every
    // later pair, so the fold would query a target nobody asked about.
    const hostileId = "team\u0000claude-code";
    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-1", queryClient, request: fetching.request },
      [target("codex", hostileId)],
      { force: true },
    );
    await waitFor(() => expect(fetching.request).toHaveBeenCalledTimes(1));

    const exact = renderHook(() =>
      useAnyRateLimitQueueTargetFetching([
        { providerId: "codex", profileId: hostileId },
      ]),
    );
    const shifted = renderHook(() =>
      useAnyRateLimitQueueTargetFetching([
        { providerId: "codex", profileId: "team" },
        { providerId: "claude-code", profileId: null },
      ]),
    );

    await waitFor(() => expect(exact.result.current).toBe(true));
    expect(shifted.result.current).toBe(false);
  });
});

describe("useIsRateLimitQueueTargetForced", () => {
  beforeEach(() => {
    __resetRateLimitQueueForTests();
    mocks.scope = { hostId: "host-1" };
  });
  afterEach(() => {
    cleanup();
    __resetRateLimitQueueForTests();
  });

  it("re-renders when a QUEUED target is promoted to forced in place", async () => {
    // The promotion mutates `pending.force` without changing the phase, so
    // nothing else publishes it. If the queue does not notify, the control the
    // user just clicked keeps reading as unforced and never shows pending.
    const queryClient = new QueryClient();
    const blocker = makeControllableRequest();
    const codex = makeControllableRequest();
    const scope = { hostId: "host-1", queryClient, request: blocker.request };
    configureRateLimitQueue(scope);

    // Occupy the lane so codex's own item stays queued.
    void enqueueRateLimitFetchBatchForScope(
      scope,
      [target("claude-code", null)],
      {
        force: true,
      },
    );
    await waitFor(() => expect(blocker.request).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() =>
      useIsRateLimitQueueTargetForced("codex", null),
    );
    expect(result.current).toBe(false);

    // An AUTOMATIC pull queues behind it - still not forced.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-1", queryClient, request: codex.request },
      [target("codex", null)],
      { force: false },
    );
    await waitFor(() =>
      expect(getRateLimitQueueTargetPhase("host-1", "codex", null)).toBe(
        "queued",
      ),
    );
    expect(result.current).toBe(false);

    // The user clicks Refresh, promoting it in place.
    void enqueueRateLimitFetchBatchForScope(
      { hostId: "host-1", queryClient, request: codex.request },
      [target("codex", null)],
      { force: true },
    );

    await waitFor(() => expect(result.current).toBe(true));
  });
});
