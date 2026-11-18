import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalSessionRecovery } from "@/hooks/terminal/use-terminal-session-recovery";

function withQueryClient(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Lets a test control exactly when `queryClient.invalidateQueries` settles. */
function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useTerminalSessionRecovery", () => {
  it("emits once when the three automatic recovery attempts are exhausted", async () => {
    const queryClient = createTestQueryClient();
    const onRecoveryExhausted = vi.fn();
    const { result } = renderHook(
      () =>
        useTerminalSessionRecovery({
          hostId: "host-1",
          instanceId: "instance-1",
          onRecoveryExhausted,
        }),
      { wrapper: withQueryClient(queryClient) },
    );

    // Each attempt must be allowed to settle (its `terminal.list`
    // invalidation resolve) before the next one fires - a still-in-flight
    // attempt coalesces a duplicate call rather than spending a second unit
    // of the auto-recovery budget (see the coalescing test below).
    for (let attempt = 1; attempt <= 3; attempt++) {
      act(() => {
        result.current.onSessionLost();
      });
      await waitFor(() => expect(result.current.recoverNonce).toBe(attempt));
    }
    expect(onRecoveryExhausted).not.toHaveBeenCalled();

    // The budget is now exhausted: neither of these two extra calls starts a
    // 4th attempt, and the exhaustion callback still fires only once.
    act(() => {
      result.current.onSessionLost();
      result.current.onSessionLost();
    });

    expect(result.current.recoveryExhausted).toBe(true);
    expect(onRecoveryExhausted).toHaveBeenCalledTimes(1);
    expect(result.current.recoverNonce).toBe(3);
  });

  it("does not emit when a lost stream heals within the automatic budget", () => {
    const queryClient = createTestQueryClient();
    const onRecoveryExhausted = vi.fn();
    const { result } = renderHook(
      () =>
        useTerminalSessionRecovery({
          hostId: "host-1",
          instanceId: "instance-1",
          onRecoveryExhausted,
        }),
      { wrapper: withQueryClient(queryClient) },
    );

    act(() => {
      result.current.onSessionLost();
      result.current.onSessionHealthy();
    });

    expect(result.current.recoveryExhausted).toBe(false);
    expect(onRecoveryExhausted).not.toHaveBeenCalled();
  });

  it("does not bump recoverNonce until the terminal.list invalidation settles", async () => {
    const queryClient = createTestQueryClient();
    const deferred = createDeferred<void>();
    const invalidateSpy = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockReturnValue(deferred.promise);
    const onRecoveryExhausted = vi.fn();

    const { result } = renderHook(
      () =>
        useTerminalSessionRecovery({
          hostId: "host-1",
          instanceId: "instance-1",
          onRecoveryExhausted,
        }),
      { wrapper: withQueryClient(queryClient) },
    );

    act(() => {
      result.current.onSessionLost();
    });

    // The handle is force-released immediately, but the tile's bootstrap
    // subtree must not remount (nonce bump) until fresh host authority has
    // actually settled - otherwise a stale, retained `terminal.list` row
    // could resubscribe against the already-dead PTY incarnation.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(result.current.recoverNonce).toBe(0);

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(result.current.recoverNonce).toBe(1);
  });

  it("coalesces duplicate lost callbacks into a single in-flight recovery attempt", async () => {
    const queryClient = createTestQueryClient();
    const first = createDeferred<void>();
    const invalidateSpy = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockReturnValue(first.promise);
    const onRecoveryExhausted = vi.fn();

    const { result } = renderHook(
      () =>
        useTerminalSessionRecovery({
          hostId: "host-1",
          instanceId: "instance-1",
          onRecoveryExhausted,
        }),
      { wrapper: withQueryClient(queryClient) },
    );

    act(() => {
      result.current.onSessionLost();
      result.current.onSessionLost();
      result.current.onSessionLost();
    });

    // All three calls landed while the first attempt was still in flight -
    // exactly one invalidation, so exactly one unit of the auto-recovery
    // budget was spent, not three.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(result.current.recoverNonce).toBe(1);

    // Two more, fully sequential (non-overlapping) attempts still fit inside
    // the three-attempt budget - proving the coalesced burst above spent only
    // ONE unit rather than three (which would have exhausted the budget here
    // instead of allowing these to proceed).
    const second = createDeferred<void>();
    invalidateSpy.mockReturnValueOnce(second.promise);
    act(() => {
      result.current.onSessionLost();
    });
    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(result.current.recoverNonce).toBe(2);
    expect(result.current.recoveryExhausted).toBe(false);

    const third = createDeferred<void>();
    invalidateSpy.mockReturnValueOnce(third.promise);
    act(() => {
      result.current.onSessionLost();
    });
    await act(async () => {
      third.resolve();
      await third.promise;
    });
    expect(result.current.recoverNonce).toBe(3);
    expect(onRecoveryExhausted).not.toHaveBeenCalled();

    // The budget is exhausted only NOW, on the true 4th attempt.
    act(() => {
      result.current.onSessionLost();
    });
    expect(result.current.recoveryExhausted).toBe(true);
    expect(onRecoveryExhausted).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
  });

  it("does not double-invalidate when a manual reconnect arrives while auto recovery is in flight", async () => {
    const queryClient = createTestQueryClient();
    const deferred = createDeferred<void>();
    const invalidateSpy = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockReturnValue(deferred.promise);
    const onRecoveryExhausted = vi.fn();

    const { result } = renderHook(
      () =>
        useTerminalSessionRecovery({
          hostId: "host-1",
          instanceId: "instance-1",
          onRecoveryExhausted,
        }),
      { wrapper: withQueryClient(queryClient) },
    );

    act(() => {
      result.current.onSessionLost();
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    // A user-initiated Reconnect click racing the still-in-flight auto
    // attempt must not stack a second invalidation/nonce bump - `doRecover`'s
    // own in-flight guard applies uniformly to both callers.
    act(() => {
      result.current.onManualReconnect();
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(result.current.recoverNonce).toBe(0);

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    // The one attempt that was actually in flight (the auto one) is what
    // settles - not a phantom duplicate.
    expect(result.current.recoverNonce).toBe(1);
  });

  it("a manual reconnect after budget exhaustion still starts a fresh attempt", async () => {
    const queryClient = createTestQueryClient();
    const onRecoveryExhausted = vi.fn();
    const { result } = renderHook(
      () =>
        useTerminalSessionRecovery({
          hostId: "host-1",
          instanceId: "instance-1",
          onRecoveryExhausted,
        }),
      { wrapper: withQueryClient(queryClient) },
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
      act(() => {
        result.current.onSessionLost();
      });
      await waitFor(() => expect(result.current.recoverNonce).toBe(attempt));
    }
    act(() => {
      result.current.onSessionLost();
    });
    expect(result.current.recoveryExhausted).toBe(true);

    act(() => {
      result.current.onManualReconnect();
    });

    expect(result.current.recoveryExhausted).toBe(false);
    await waitFor(() => expect(result.current.recoverNonce).toBe(4));
  });
});
