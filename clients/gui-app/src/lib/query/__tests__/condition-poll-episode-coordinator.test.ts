import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CancelledError,
  QueryClient,
  QueryObserver,
  type Query,
  type QueryKey,
} from "@tanstack/react-query";
import { stampHostRpcMethod } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  getConditionPollEpisodeCoordinator,
  type ConditionPollEpisodeCoordinator,
  type ConditionPollRefetchInterval,
} from "@/lib/query/condition-poll-episode-coordinator";

const HARNESS_METHOD = "agent.gui.listHarnesses" as const;
const PROVIDERS_METHOD = "providers.list" as const;

const SECOND_MS = 1_000;
const UNAVAILABLE_INITIAL_MS = 30 * SECOND_MS;
const UNAVAILABLE_SECOND_MS = 60 * SECOND_MS;
const UNAVAILABLE_THIRD_MS = 120 * SECOND_MS;
const PENDING_INITIAL_MS = 800;
const ALL_AVAILABLE_MS = 15 * 60 * SECOND_MS;

type HarnessData = {
  readonly harnesses: ReadonlyArray<{
    readonly available: boolean;
    readonly availabilityPending: boolean;
    readonly n: number;
  }>;
};

const unavailable = (n: number): HarnessData => ({
  harnesses: [{ available: false, availabilityPending: false, n }],
});

const pending = (n: number): HarnessData => ({
  harnesses: [{ available: false, availabilityPending: true, n }],
});

const allAvailable = (n: number): HarnessData => ({
  harnesses: [{ available: true, availabilityPending: false, n }],
});

describe("condition-poll episode coordinator", () => {
  let client: QueryClient;
  let coordinator: ConditionPollEpisodeCoordinator;
  let unsubscribes: Array<() => void>;
  let seq: number;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: Infinity,
          staleTime: Infinity,
        },
      },
    });
    coordinator = getConditionPollEpisodeCoordinator(client);
    unsubscribes = [];
    seq = 0;
  });

  afterEach(() => {
    for (const unsubscribe of unsubscribes.splice(0).reverse()) {
      unsubscribe();
    }
    coordinator.dispose();
    client.clear();
    vi.useRealTimers();
  });

  it("latches the first stamp when a same-key observer stamps a different method and asserts in test", () => {
    const key = nextKey("latch-mismatch");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));

    const first = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    expect(() => {
      mountBrandedObserver({
        key,
        method: PROVIDERS_METHOD,
        // Conflicting stamp on the same query hash; first-writer latch holds.
        interval: coordinator.refetchIntervalFor(PROVIDERS_METHOD),
        meta: undefined,
      });
    }).toThrow(/changed hostRpcMethod/);

    // First-writer-wins: the original method still owns the episode delay.
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);
    expect(queryFor(key)?.options.meta).toMatchObject({
      hostRpcMethod: PROVIDERS_METHOD,
    });

    first.unsubscribe();
  });

  it("keeps the builder-owned hostRpcMethod when caller meta tries to override it", () => {
    const key = nextKey("builder-stamp");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    const meta = stampHostRpcMethod(
      { hostRpcMethod: PROVIDERS_METHOD, caller: true },
      HARNESS_METHOD,
    );
    expect(meta.hostRpcMethod).toBe(HARNESS_METHOD);

    client.setQueryData(key, unavailable(0));
    const observer = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta,
    });

    expect(queryFor(key)?.options.meta).toMatchObject({
      hostRpcMethod: HARNESS_METHOD,
      caller: true,
    });
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    client.setQueryData(key, unavailable(1));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    observer.unsubscribe();
  });

  it("keeps the latched method (no crash) when an unstamped same-key fetchQuery clears meta", async () => {
    const key = nextKey("unstamped-fetch");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));
    const observer = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    // Force the query stale so fetchQuery actually runs Query.fetch/setOptions
    // and replaces options.meta (Infinity would short-circuit on fresh cache).
    vi.setSystemTime(Date.now() + 60_000);

    // A raw same-key fetch (an imperative `fetchQuery`/`ensureQueryData`, or the
    // worktree-enrichment batched `useQueries` leg) clears the stamped meta.
    // That is an ABSENT opinion, not a method change: the latch holds, the
    // fetch resolves, and the app does NOT crash. Before the fix this rejected
    // with the identity assertion — the crash that surfaced in <WorktreesBody>.
    await expect(
      client.fetchQuery({
        queryKey: key,
        queryFn: () => Promise.resolve(pending(1)),
        staleTime: 0,
      }),
    ).resolves.toEqual(pending(1));

    // The latched HARNESS episode survives the unstamped write and reclassifies
    // the freshly-fetched pending data through its own PENDING lane.
    expect(currentDelay(key, interval)).toBe(PENDING_INITIAL_MS);

    observer.unsubscribe();
  });

  it("does not crash when a raw unstamped same-key observer (batched enrichment) clears meta", () => {
    // Production shape: `useWorktreeOwnerMetadata` (a stamped `useHostQuery`)
    // and `useBatchedEnrichmentQueries` (a RAW `useQueries` leg that omits the
    // meta stamp for its coalesced transport) build the SAME host query key.
    // TanStack's last-writer `query.options.meta` flips to unstamped when the
    // raw leg mounts; the latch must hold rather than throw `→ missing`.
    const key = nextKey("raw-unstamped-coobserver");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));

    const stamped = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);
    expect(queryFor(key)?.options.meta).toMatchObject({
      hostRpcMethod: HARNESS_METHOD,
    });

    let rawUnsubscribe: (() => void) | undefined;
    expect(() => {
      // No meta stamp, no branded interval — the raw enrichment leg.
      const raw = new QueryObserver(client, {
        queryKey: key,
        queryFn: () => Promise.resolve(unavailable(1)),
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
      });
      rawUnsubscribe = raw.subscribe(() => undefined);
      unsubscribes.push(rawUnsubscribe);
    }).not.toThrow();

    // Last-writer meta is now unstamped, yet the latched HARNESS episode is
    // intact and still classifies its data through the latched method.
    expect(queryFor(key)?.options.meta).toBeUndefined();
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    rawUnsubscribe?.();
    stamped.unsubscribe();
  });

  it("throws for a host-prefixed polling observer without a hostRpcMethod stamp", () => {
    expect(() => {
      const observer = new QueryObserver(client, {
        queryKey: ["host", "test-host", "host.status", {}],
        queryFn: () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.0.0",
            protocolVersion: { major: 1, minor: 0 },
          }),
        // Deliberately unstamped: the strict T4 sweep must fail this poller.
        refetchInterval: 5_000,
        staleTime: Infinity,
        gcTime: Infinity,
      });
      const unsubscribe = observer.subscribe(() => undefined);
      unsubscribes.push(unsubscribe);
    }).toThrow(/missing a hostRpcMethod stamp/);
  });

  it("resumes per-lane counters across unavailable → pending → unavailable", () => {
    const key = nextKey("resume-trace");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));
    const observer = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });

    // beginEpisode primes the initial delay without consuming an attempt; the
    // next four Query versions are the plan's resume trace.
    client.setQueryData(key, unavailable(1));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    client.setQueryData(key, unavailable(2));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_SECOND_MS);

    client.setQueryData(key, pending(3));
    expect(currentDelay(key, interval)).toBe(PENDING_INITIAL_MS);

    client.setQueryData(key, unavailable(4));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_THIRD_MS);

    observer.unsubscribe();
  });

  it("clears counters when entering a declared reset lane", () => {
    const key = nextKey("reset-lane");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));
    const observer = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });

    client.setQueryData(key, unavailable(1));
    client.setQueryData(key, unavailable(2));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_SECOND_MS);

    client.setQueryData(key, allAvailable(3));
    expect(currentDelay(key, interval)).toBe(ALL_AVAILABLE_MS);

    client.setQueryData(key, unavailable(4));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    observer.unsubscribe();
  });

  it("does not own an episode when every observer opts out with poll:false", () => {
    const key = nextKey("all-opted-out");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));

    const passive = mountPassiveObserver({
      key,
      method: HARNESS_METHOD,
    });

    expect(currentDelay(key, interval)).toBe(false);

    client.setQueryData(key, unavailable(1));
    expect(currentDelay(key, interval)).toBe(false);

    passive.unsubscribe();
  });

  it("goes dormant when the last branded poller unmounts while a passive observer remains", () => {
    const key = nextKey("last-poller-unmounted");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));

    const poller = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });
    const passive = mountPassiveObserver({
      key,
      method: HARNESS_METHOD,
    });

    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    poller.unsubscribe();
    expect(currentDelay(key, interval)).toBe(false);

    client.setQueryData(key, unavailable(1));
    expect(currentDelay(key, interval)).toBe(false);

    passive.unsubscribe();
  });

  it("resets on remount after the last branded observer unsubscribes before GC", () => {
    const key = nextKey("remount-before-gc");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));

    const first = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });
    client.setQueryData(key, unavailable(1));
    client.setQueryData(key, unavailable(2));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_SECOND_MS);

    first.unsubscribe();
    expect(currentDelay(key, interval)).toBe(false);
    // Query remains cached (gcTime: Infinity) so remount is 0 → 1, not a new Query.
    expect(queryFor(key)).toBeDefined();

    const second = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });
    // Fresh episode primes attempt-zero delay again.
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    client.setQueryData(key, unavailable(3));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    second.unsubscribe();
  });

  it("counts a manual setQueryData write as one settlement", () => {
    const key = nextKey("manual-setQueryData");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));
    const observer = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });

    const before = queryFor(key)?.state.dataUpdateCount ?? 0;
    client.setQueryData(key, unavailable(1));
    expect(queryFor(key)?.state.dataUpdateCount).toBe(before + 1);
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    client.setQueryData(key, unavailable(2));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_SECOND_MS);

    observer.unsubscribe();
  });

  it("does not enter an error lane or advance counters for expected cancellation", () => {
    const key = nextKey("expected-cancel");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));
    const observer = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });

    client.setQueryData(key, unavailable(1));
    client.setQueryData(key, unavailable(2));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_SECOND_MS);

    const query = queryFor(key);
    expect(query).toBeDefined();
    if (query === undefined) {
      throw new Error("expected query");
    }

    const beforeErrorCount = query.state.errorUpdateCount;
    query.setState({
      ...query.state,
      error: new CancelledError({ silent: true }),
      errorUpdateCount: beforeErrorCount + 1,
    });

    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_SECOND_MS);
    expect(query.state.errorUpdateCount).toBe(beforeErrorCount + 1);

    // A subsequent data settlement still resumes the unavailable counter.
    client.setQueryData(key, unavailable(3));
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_THIRD_MS);

    observer.unsubscribe();
  });

  it("dispose unsubscribes the cache listener and stops further episode work", () => {
    const key = nextKey("dispose");
    const interval = coordinator.refetchIntervalFor(HARNESS_METHOD);
    client.setQueryData(key, unavailable(0));
    const observer = mountBrandedObserver({
      key,
      method: HARNESS_METHOD,
      interval,
      meta: undefined,
    });
    expect(currentDelay(key, interval)).toBe(UNAVAILABLE_INITIAL_MS);

    coordinator.dispose();
    expect(currentDelay(key, interval)).toBe(false);

    client.setQueryData(key, unavailable(1));
    expect(currentDelay(key, interval)).toBe(false);

    observer.unsubscribe();
  });

  it("applies the table's current settlement delay to real harness and providers timers", async () => {
    vi.setSystemTime(0);

    const harnessFetchTimes: number[] = [];
    const harnessObserver = new QueryObserver(client, {
      queryKey: ["host", "test-host", HARNESS_METHOD, "timer-harness"],
      queryFn: () => {
        harnessFetchTimes.push(Date.now());
        return Promise.resolve(unavailable(harnessFetchTimes.length));
      },
      meta: stampHostRpcMethod(undefined, HARNESS_METHOD),
      retry: false,
      refetchInterval: coordinator.refetchIntervalFor(HARNESS_METHOD),
      refetchIntervalInBackground: true,
      staleTime: Infinity,
      gcTime: Infinity,
    });
    const stopHarness = harnessObserver.subscribe(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30 * SECOND_MS);
    await vi.advanceTimersByTimeAsync(60 * SECOND_MS);
    await vi.advanceTimersByTimeAsync(120 * SECOND_MS);
    await vi.advanceTimersByTimeAsync(240 * SECOND_MS);
    await vi.advanceTimersByTimeAsync(300 * SECOND_MS);

    expect(fetchDeltas(harnessFetchTimes)).toEqual([
      30 * SECOND_MS,
      60 * SECOND_MS,
      120 * SECOND_MS,
      240 * SECOND_MS,
      300 * SECOND_MS,
    ]);
    stopHarness();

    const providerFetchTimes: number[] = [];
    const providerObserver = new QueryObserver(client, {
      queryKey: ["host", "test-host", PROVIDERS_METHOD, "timer-providers"],
      queryFn: () => {
        providerFetchTimes.push(Date.now());
        return Promise.resolve({
          providers: [
            {
              enabled: true,
              authPending: true,
              availabilityPending: false,
              candidates: [],
              profiles: [],
            },
          ],
        });
      },
      meta: stampHostRpcMethod(undefined, PROVIDERS_METHOD),
      retry: false,
      refetchInterval: coordinator.refetchIntervalFor(PROVIDERS_METHOD),
      refetchIntervalInBackground: true,
      staleTime: Infinity,
      gcTime: Infinity,
    });
    const stopProviders = providerObserver.subscribe(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(1_600);
    await vi.advanceTimersByTimeAsync(3_200);
    await vi.advanceTimersByTimeAsync(6_400);

    expect(fetchDeltas(providerFetchTimes)).toEqual([800, 1_600, 3_200, 6_400]);
    stopProviders();
  });

  it("resumes a real timer after speech polling re-enters from a terminal lane", async () => {
    vi.setSystemTime(0);
    const speechFetchTimes: number[] = [];
    const speechStates = [
      "downloading",
      "ready",
      "downloading",
      "downloading",
    ] as const;
    let speechStateIndex = 0;
    const method = "speech.getModelStatus" as const;
    const key = ["host", "test-host", method, "timer-speech"];
    const fetchSpeechState = () => {
      speechFetchTimes.push(Date.now());
      const state =
        speechStates[Math.min(speechStateIndex, speechStates.length - 1)];
      speechStateIndex += 1;
      return Promise.resolve({ downloadState: state });
    };
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: fetchSpeechState,
      meta: stampHostRpcMethod(undefined, method),
      retry: false,
      refetchInterval: coordinator.refetchIntervalFor(method),
      refetchIntervalInBackground: true,
      staleTime: Infinity,
      gcTime: Infinity,
    });
    const stop = observer.subscribe(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1);
    await client.fetchQuery({
      queryKey: key,
      queryFn: fetchSpeechState,
      meta: stampHostRpcMethod(undefined, method),
      retry: false,
      staleTime: 0,
    });
    await vi.advanceTimersByTimeAsync(1_500);

    expect(speechFetchTimes).toEqual([0, 1_500, 1_501, 3_001]);
    stop();
  });

  it("starts active data at its initial delay after cold-error attempts", async () => {
    vi.setSystemTime(0);
    const method = "speech.getModelStatus" as const;
    const fetchTimes: number[] = [];
    const outcomes = [
      () => Promise.reject(new Error("cold one")),
      () => Promise.reject(new Error("cold two")),
      () => Promise.resolve({ downloadState: "downloading" }),
      () => Promise.resolve({ downloadState: "downloading" }),
    ];
    let outcomeIndex = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["host", "test-host", method, "cold-error-data"],
      queryFn: () => {
        fetchTimes.push(Date.now());
        const outcome = outcomes[outcomeIndex];
        outcomeIndex += 1;
        return outcome();
      },
      meta: stampHostRpcMethod(undefined, method),
      retry: false,
      refetchInterval: coordinator.refetchIntervalFor(method),
      refetchIntervalInBackground: true,
      staleTime: Infinity,
      gcTime: Infinity,
    });
    const stop = observer.subscribe(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);

    // The two initial errors consume their own error-lane exponent. The first
    // active result must still schedule from the data lane's 1.5s base.
    expect(fetchTimes).toEqual([0, 1_500, 4_500, 6_000]);
    stop();
  });

  it("does not let a stale-data error advance the active-data exponent", async () => {
    vi.setSystemTime(0);
    const method = "speech.getModelStatus" as const;
    const fetchTimes: number[] = [];
    const outcomes = [
      () => Promise.resolve({ downloadState: "downloading" }),
      () => Promise.reject(new Error("stale data error")),
      () => Promise.resolve({ downloadState: "downloading" }),
      () => Promise.resolve({ downloadState: "downloading" }),
    ];
    let outcomeIndex = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["host", "test-host", method, "stale-error-data"],
      queryFn: () => {
        fetchTimes.push(Date.now());
        const outcome = outcomes[outcomeIndex];
        outcomeIndex += 1;
        return outcome();
      },
      meta: stampHostRpcMethod(undefined, method),
      retry: false,
      refetchInterval: coordinator.refetchIntervalFor(method),
      refetchIntervalInBackground: true,
      staleTime: Infinity,
      gcTime: Infinity,
    });
    const stop = observer.subscribe(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(3_000);

    // The active lane resumes its own previous exponent after the stale-data
    // error: 1.5s → 1.5s → 3s, rather than inheriting an error exponent.
    expect(fetchTimes).toEqual([0, 1_500, 3_000, 6_000]);
    stop();
  });

  function nextKey(label: string): QueryKey {
    seq += 1;
    return ["host", "test-host", HARNESS_METHOD, label, seq];
  }

  function queryFor(key: QueryKey): Query | undefined {
    return client.getQueryCache().find({ queryKey: key, exact: true });
  }

  function currentDelay(
    key: QueryKey,
    interval: ConditionPollRefetchInterval,
  ): number | false | undefined {
    const query = queryFor(key);
    if (query === undefined) return false;
    return interval(query);
  }

  function fetchDeltas(fetchTimes: readonly number[]): number[] {
    return fetchTimes.slice(1).map((time, index) => time - fetchTimes[index]);
  }

  function mountBrandedObserver(args: {
    readonly key: QueryKey;
    readonly method: typeof HARNESS_METHOD | typeof PROVIDERS_METHOD;
    readonly interval: ConditionPollRefetchInterval;
    readonly meta: Record<string, unknown> | undefined;
  }): { readonly unsubscribe: () => void } {
    const meta =
      args.meta === undefined
        ? stampHostRpcMethod(undefined, args.method)
        : args.meta;

    const observer = new QueryObserver(client, {
      queryKey: args.key,
      queryFn: () => Promise.resolve(unavailable(99)),
      meta,
      retry: false,
      refetchInterval: args.interval,
      staleTime: Infinity,
      gcTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    unsubscribes.push(unsubscribe);
    return {
      unsubscribe: () => {
        unsubscribe();
        const index = unsubscribes.indexOf(unsubscribe);
        if (index >= 0) unsubscribes.splice(index, 1);
      },
    };
  }

  function mountPassiveObserver(args: {
    readonly key: QueryKey;
    readonly method: typeof HARNESS_METHOD | typeof PROVIDERS_METHOD;
  }): { readonly unsubscribe: () => void } {
    // poll: false — stamped, but no branded refetchInterval, so never owns.
    const observer = new QueryObserver(client, {
      queryKey: args.key,
      queryFn: () => Promise.resolve(unavailable(99)),
      meta: stampHostRpcMethod(undefined, args.method),
      retry: false,
      staleTime: Infinity,
      gcTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    unsubscribes.push(unsubscribe);
    return {
      unsubscribe: () => {
        unsubscribe();
        const index = unsubscribes.indexOf(unsubscribe);
        if (index >= 0) unsubscribes.splice(index, 1);
      },
    };
  }
});
