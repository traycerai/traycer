import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  notifyManager,
  QueryClientProvider,
  useMutation,
  type QueryClient,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Suspense,
  use,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";
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

interface ConcurrentCommit {
  readonly which: "a" | "b";
  readonly result: readonly string[];
}

/**
 * Reads the hook for `which` (recording the attempt, even if this render
 * never commits), then - for "b" only, and only after that read - suspends
 * forever. A transition landing on "b" therefore leaves the previously
 * committed "a" output on screen with `isPending` stuck `true`, instead of
 * showing the Suspense fallback. `onCommit` runs in a passive effect, so -
 * unlike `attempts` - it only records a render that actually committed,
 * which is the real-array-identity evidence the assertions need (DOM text
 * can only prove the rendered VALUES matched, not that the same array
 * object was reused).
 */
function ConcurrentKeyWatcher(props: {
  readonly which: "a" | "b";
  readonly attempts: ("a" | "b")[];
  readonly suspendOnB: Promise<never>;
  readonly onCommit: (commit: ConcurrentCommit) => void;
}) {
  const filters =
    props.which === "a"
      ? { mutationKey: ["concurrent-key-a"] }
      : { mutationKey: ["concurrent-key-b"] };
  const result = useMutationStateOf(
    filters,
    (mutation) => mutation.state.status,
  );
  props.attempts.push(props.which);
  if (props.which === "b") {
    use(props.suspendOnB);
  }
  // No dependency array: this must fire after every commit of this fiber,
  // which is exactly what "only a genuine commit records a result" needs.
  useEffect(() => {
    props.onCommit({ which: props.which, result });
  });
  return <div data-testid="concurrent-watcher">{JSON.stringify(result)}</div>;
}

function ConcurrentRoot(props: {
  readonly attempts: ("a" | "b")[];
  readonly suspendOnB: Promise<never>;
  readonly onCommit: (commit: ConcurrentCommit) => void;
}) {
  const [which, setWhich] = useState<"a" | "b">("a");
  const [isPending, startTransition] = useTransition();
  return (
    <div>
      <button
        type="button"
        onClick={() => startTransition(() => setWhich("b"))}
      >
        switch to b
      </button>
      <span data-testid="pending">{String(isPending)}</span>
      <Suspense fallback={<div data-testid="fallback">loading</div>}>
        <ConcurrentKeyWatcher
          which={which}
          attempts={props.attempts}
          suspendOnB={props.suspendOnB}
          onCommit={props.onCommit}
        />
      </Suspense>
    </div>
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

    // A real, independent subscriber on the cache catches every event
    // synchronously (`MutationCache.notify` delivers to its listeners inside
    // its own `notifyManager.batch`, before `notify` returns) - unlike the
    // watcher's re-render, which the real scheduler can defer. Mounted before
    // the mutate/settle below too, so the assertions that follow prove it is
    // a live, working listener (it DOES see "added"/"updated"), not merely
    // one that happens to stay empty.
    const events: Array<{ readonly type: string }> = [];
    const unsubscribe = queryClient
      .getMutationCache()
      .subscribe((event) => events.push(event));

    act(() => {
      producer.result.current.mutate();
    });
    await waitFor(() => expect(watcher.result.current).toEqual(["pending"]));
    const callsAfterPending = select.mock.calls.length;
    expect(callsAfterPending).toBeGreaterThan(0);
    const eventsAfterPending = events.length;
    expect(eventsAfterPending).toBeGreaterThan(0);

    act(() => resolveWork(1));
    await waitFor(() => expect(watcher.result.current).toEqual(["success"]));
    const callsAfterSettle = select.mock.calls.length;
    expect(callsAfterSettle).toBeGreaterThan(callsAfterPending);
    expect(events.length).toBeGreaterThan(eventsAfterPending);

    // This is the deterministic witness for "no leaked event" below, with no
    // sleep or drain count needed: if a stray `observerOptionsUpdated` got
    // through, it would already be in `events` by the time the loop returns.
    events.length = 0;

    // No further `mutate()` call below: each re-render only passes a new
    // `mutationFn` closure, exactly what drives `useMutation`'s effect to call
    // `observer.setOptions` on every commit.
    for (let tick = 1; tick <= 5; tick += 1) {
      act(() => {
        producer.rerender({ renderTick: tick });
      });
    }
    unsubscribe();
    expect(events).toEqual([]);
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

  it("keeps the same snapshot array across re-renders that only pass fresh inline filters/select, and subscribes to the cache once", async () => {
    const queryClient = createAppQueryClient();
    const wrapper = wrapperFor(queryClient);
    const mutationCache = queryClient.getMutationCache();
    const subscribeSpy = vi.spyOn(mutationCache, "subscribe");

    const producer = renderHook(
      () =>
        useMutation({
          mutationKey: ["steady-mutation"],
          mutationFn: () => Promise.resolve("done"),
        }),
      { wrapper },
    );
    act(() => producer.result.current.mutate());
    await waitFor(() => expect(producer.result.current.isSuccess).toBe(true));
    expect(
      mutationCache.findAll({ mutationKey: ["steady-mutation"] }),
    ).toHaveLength(1);

    // Every render below passes a brand-new filters object (predicate
    // included) and a brand-new select closure - the same identity churn a
    // call site with inline options produces. The cache data behind them
    // never changes.
    const watcher = renderHook(
      (_props: { tick: number }) =>
        useMutationStateOf(
          {
            mutationKey: ["steady-mutation"],
            predicate: (mutation) => mutation.state.status !== "error",
          },
          (mutation) => mutation.state.status === "success",
        ),
      { wrapper, initialProps: { tick: 0 } },
    );
    const firstSnapshot = watcher.result.current;
    expect(firstSnapshot).toEqual([true]);

    for (let tick = 1; tick <= 4; tick += 1) {
      act(() => {
        watcher.rerender({ tick });
      });
    }

    expect(watcher.result.current).toBe(firstSnapshot);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    subscribeSpy.mockRestore();
  });

  it("does not re-scan the cache when a rerender's filters are only structurally equal (not the same object) and select is stable", async () => {
    const queryClient = createAppQueryClient();
    const wrapper = wrapperFor(queryClient);

    const producer = renderHook(
      () =>
        useMutation({
          mutationKey: ["equal-structure-mutation"],
          mutationFn: () => Promise.resolve("done"),
        }),
      { wrapper },
    );
    act(() => producer.result.current.mutate());
    await waitFor(() => expect(producer.result.current.isSuccess).toBe(true));

    const select = vi.fn(
      (mutation: { state: { status: string } }) => mutation.state.status,
    );
    // `select` is hoisted (the SAME reference on every render, unlike the
    // previous test's fresh closure); `mutationKey` is a brand-new array
    // literal every render, but one with the SAME content every time - the
    // shape a call site building its key from stable, unchanged inputs
    // produces, as opposed to a genuinely different key.
    const watcher = renderHook(
      (_props: { renderTick: number }) =>
        useMutationStateOf(
          { mutationKey: ["equal-structure-mutation"] },
          select,
        ),
      { wrapper, initialProps: { renderTick: 0 } },
    );
    const firstSnapshot = watcher.result.current;
    expect(firstSnapshot).toEqual(["success"]);
    const callsAfterMount = select.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    for (let renderTick = 1; renderTick <= 4; renderTick += 1) {
      act(() => {
        watcher.rerender({ renderTick });
      });
    }

    // Structurally-equal filters and an unchanged select, against cache
    // data that never changed, must not cost another cache scan: `select`
    // is called no more than it already was at mount, and the result stays
    // the exact same array.
    expect(select.mock.calls.length).toBe(callsAfterMount);
    expect(watcher.result.current).toBe(firstSnapshot);
  });

  it("keeps the committed watcher's array identity across a transition that suspends on a different key", async () => {
    const queryClient = createAppQueryClient();
    const wrapper = wrapperFor(queryClient);

    const producerA = renderHook(
      () =>
        useMutation({
          mutationKey: ["concurrent-key-a"],
          mutationFn: () => Promise.resolve("done"),
        }),
      { wrapper },
    );
    act(() => producerA.result.current.mutate());
    await waitFor(() => expect(producerA.result.current.isSuccess).toBe(true));

    const attempts: ("a" | "b")[] = [];
    const commits: ConcurrentCommit[] = [];
    const suspendOnB = new Promise<never>(() => undefined);
    render(
      <ConcurrentRoot
        attempts={attempts}
        suspendOnB={suspendOnB}
        onCommit={(commit) => commits.push(commit)}
      />,
      { wrapper },
    );
    await waitFor(() => expect(commits).toHaveLength(1));
    const committedA1 = commits[0];
    expect(committedA1.which).toBe("a");
    expect(committedA1.result).toEqual(["success"]);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "switch to b" }));
    });

    // Await the actual observed outcome - the "b" render attempt itself -
    // rather than a guessed flush; this never waits on `suspendOnB`, which
    // never resolves.
    await waitFor(() => expect(attempts).toContain("b"));

    // The transition rendered key "b" (it read the hook, recorded above)
    // without ever COMMITTING: `commits` never gains a "b" entry (its
    // passive effect never runs for an aborted/suspended render). React may
    // re-commit the still-current "a" branch once on the way there (it
    // renders the `isPending` flip against the OLD state before attempting
    // the transition's new state), which is why this checks every recorded
    // commit rather than the commit count - the screen still shows key "a"'s
    // output instead of the Suspense fallback, and the transition is still
    // marked pending because its promise never resolves.
    for (const commit of commits) {
      expect(commit.which).toBe("a");
      expect(commit.result).toBe(committedA1.result);
    }
    expect(screen.queryByTestId("fallback")).toBeNull();
    expect(screen.getByTestId("pending").textContent).toBe("true");
    expect(screen.getByTestId("concurrent-watcher").textContent).toBe(
      JSON.stringify(committedA1.result),
    );

    // An unrelated mutation fires real cache events that reach key "a"'s
    // subscription (every mutation notifies the whole cache; filtering by
    // key happens inside `read()`, not at `subscribe()`). Await the actual
    // scheduler completion rather than a guessed delay: `notifyManager`
    // processes `schedule()` calls in registration order on the real
    // macrotask queue, so a marker scheduled immediately after `mutate()`
    // is guaranteed to run only once every task that mutation's own
    // "added"/"updated" notifications already queued has run - including
    // whatever re-render of the committed key-"a" watcher those produced.
    const producerUnrelated = renderHook(
      () =>
        useMutation({
          mutationKey: ["concurrent-unrelated"],
          mutationFn: () => Promise.resolve("done"),
        }),
      { wrapper },
    );
    await act(async () => {
      producerUnrelated.result.current.mutate();
      await new Promise<void>((resolve) => {
        notifyManager.schedule(() => resolve());
      });
    });

    // Key "a"'s underlying data never changed, so every commit recorded
    // from here on (there may be zero or more, depending on whether that
    // unrelated event actually triggered a re-render) keeps the EXACT SAME
    // array reference as `committedA1` - the suspended "b" attempt never
    // touched it, because its snapshot is this render's own `useMemo`,
    // seeded from this fiber's own committed React state, never a value
    // shared across renders with different filters.
    for (const commit of commits) {
      expect(commit.which).toBe("a");
      expect(commit.result).toBe(committedA1.result);
    }
    expect(screen.getByTestId("concurrent-watcher").textContent).toBe(
      JSON.stringify(committedA1.result),
    );
  });
});
