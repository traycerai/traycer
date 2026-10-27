import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClientProvider,
  useMutation,
  type QueryClient,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { createAppQueryClient } from "@/lib/query-client";
import {
  useIsMutatingOf,
  useMutationStateOf,
} from "@/hooks/use-mutation-state-of";

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

// `useMutation`'s effect calls `observer.setOptions(options)` on every commit
// whose caller passes a fresh options object (an inline `mutationFn` in
// particular never passes `shallowEqualObjects`). On an unpatched
// `MutationCache` that fires `observerOptionsUpdated` for ANY mutation,
// settled ones included, so a neighboring `useMutationStateOf` /
// `useIsMutatingOf` watcher re-runs `findAll(...).map(select)` over the whole
// cache on every one of those commits - cost that scales with renders ×
// watchers × cached mutations. `AppMutationCache` (lib/query-client.ts) drops
// that event once the mutation is no longer pending.
describe("useMutationStateOf / useIsMutatingOf against the real mutation cache", () => {
  afterEach(() => cleanup());

  it("does not re-run a watcher's select for a settled mutation's render churn, but still tracks mutate-then-settle", async () => {
    const queryClient = createAppQueryClient();
    const wrapper = wrapperFor(queryClient);
    const select = vi.fn(
      (mutation: { state: { status: string } }) => mutation.state.status,
    );

    let resolveWork: (value: number) => void = () => undefined;
    const work = new Promise<number>((resolve) => {
      resolveWork = resolve;
    });

    const producer = renderHook(
      (props: { renderTick: number }) =>
        useMutation({
          mutationKey: ["probe-mutation"],
          mutationFn: () => work.then(() => props.renderTick),
        }),
      { wrapper, initialProps: { renderTick: 0 } },
    );
    const watcher = renderHook(
      () => useMutationStateOf({ mutationKey: ["probe-mutation"] }, select),
      { wrapper },
    );
    expect(watcher.result.current).toEqual([]);
    expect(select).not.toHaveBeenCalled();

    act(() => {
      producer.result.current.mutate();
    });
    await waitFor(() => expect(watcher.result.current).toEqual(["pending"]));
    const callsAfterPending = select.mock.calls.length;
    expect(callsAfterPending).toBeGreaterThan(0);

    act(() => resolveWork(1));
    await waitFor(() => expect(watcher.result.current).toEqual(["success"]));
    const callsAfterSettle = select.mock.calls.length;
    expect(callsAfterSettle).toBeGreaterThan(callsAfterPending);

    // No further `mutate()` call below: each re-render only passes a new
    // `mutationFn` closure, exactly what drives `useMutation`'s effect to call
    // `observer.setOptions` on every commit.
    for (let tick = 1; tick <= 5; tick += 1) {
      act(() => {
        producer.rerender({ renderTick: tick });
      });
    }
    expect(select.mock.calls.length).toBe(callsAfterSettle);
    expect(watcher.result.current).toEqual(["success"]);
  });

  it("answers a changed watched key immediately on render, with no cache event in between", async () => {
    const queryClient = createAppQueryClient();
    const wrapper = wrapperFor(queryClient);

    let resolveB: (value: string) => void = () => undefined;
    const workB = new Promise<string>((resolve) => {
      resolveB = resolve;
    });

    const producerA = renderHook(
      () =>
        useMutation({
          mutationKey: ["race-key-a"],
          mutationFn: () => new Promise<string>(() => undefined),
        }),
      { wrapper },
    );
    const producerB = renderHook(
      () =>
        useMutation({
          mutationKey: ["race-key-b"],
          mutationFn: () => workB,
        }),
      { wrapper },
    );
    act(() => producerA.result.current.mutate());
    act(() => producerB.result.current.mutate());
    await waitFor(() => expect(producerA.result.current.isPending).toBe(true));
    act(() => resolveB("done"));
    await waitFor(() => expect(producerB.result.current.isSuccess).toBe(true));

    const watcher = renderHook(
      (props: { mutationKey: string[] }) =>
        useIsMutatingOf({ mutationKey: props.mutationKey }),
      { wrapper, initialProps: { mutationKey: ["race-key-a"] } },
    );
    expect(watcher.result.current).toBe(1);

    const notifySpy = vi.spyOn(queryClient.getMutationCache(), "notify");
    act(() => {
      watcher.rerender({ mutationKey: ["race-key-b"] });
    });

    // `useMutationStateOf`'s `useMemo` recomputes `read()` for the new
    // filters synchronously as part of this render - it never waits for the
    // cache to notify again, which is exactly the gap TanStack's own
    // `useMutationState` leaves (it keeps the PREVIOUS key's answer until the
    // next cache event).
    expect(watcher.result.current).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
    notifySpy.mockRestore();
  });
});
