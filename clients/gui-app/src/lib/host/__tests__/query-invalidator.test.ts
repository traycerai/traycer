import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryObserver,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { appLogger } from "@/lib/logger";
import { queryKeys } from "@/lib/query-keys";

const HOST_ID = "h1";

/** Same builder shape as `use-host-query.ts` (`queryKeys.hostMethod`). */
const listModelsKey = queryKeys.hostMethod<
  HostRpcRegistry,
  "agent.gui.listModels"
>(HOST_ID, "agent.gui.listModels", {
  harnessId: "claude",
  workingDirectory: null,
});

const listCommandsKey = queryKeys.hostMethod<
  HostRpcRegistry,
  "agent.gui.listCommands"
>(HOST_ID, "agent.gui.listCommands", {
  harnessId: "claude",
  workingDirectory: null,
  workingDirectories: [],
});

/**
 * Non-catalog host-scoped control. Not in the active-refetch carve-out;
 * proves ordinary methods still refetch on recovery while catalogs do not.
 * (`git.status` is not a registry method — use a real key builder target.)
 */
const controlKey = queryKeys.hostMethod<HostRpcRegistry, "git.getCapabilities">(
  HOST_ID,
  "git.getCapabilities",
  {
    hostId: HOST_ID,
    runningDir: "/repo",
    ignoreWhitespace: false,
  },
);

/**
 * traycer#912: host-scope active recovery must not re-probe harness catalogs.
 * Catalogs are cache-only (`staleTime: Infinity`) with three documented refresh
 * points; an un-carved `invalidateQueries({queryKey})` would beat that and
 * re-spawn provider CLIs on every recovery sweep. Same-host transport rebind
 * also passes `refetchActive: true` — the carve-out is global for that edge.
 */
describe("createHostQueryInvalidator / invalidateHostScope", () => {
  const stops: Array<() => void> = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) {
      stop();
    }
  });

  it("with refetchActive: true, refetches non-catalog host queries and leaves catalog methods entirely untouched", async () => {
    const queryClient = createAppQueryClient();
    const invalidator = createHostQueryInvalidator(queryClient);

    const models = mountCountedQuery(queryClient, listModelsKey, {
      staleTime: Infinity,
      impl: () => Promise.resolve({ models: ["a"] }),
    });
    const commands = mountCountedQuery(queryClient, listCommandsKey, {
      staleTime: Infinity,
      impl: () => Promise.resolve({ commands: ["c"] }),
    });
    const control = mountCountedQuery(queryClient, controlKey, {
      staleTime: 0,
      impl: () => Promise.resolve({ capabilities: [] }),
    });
    stops.push(models.stop, commands.stop, control.stop);

    await waitUntil(() => models.fetches.count === 1);
    await waitUntil(() => commands.fetches.count === 1);
    await waitUntil(() => control.fetches.count === 1);

    invalidator.invalidateHostScope(HOST_ID, {
      refetchActive: true,
      recovery: "reconnect",
    });

    // Non-catalog active observer must refetch (mutation probe: a plain
    // invalidateQueries({queryKey}) would also bump catalog counts, so this
    // assertion alone is not enough — the unchanged catalog counts below are
    // the carve-out probe).
    await waitUntil(() => control.fetches.count === 2);
    expect(control.fetches.count).toBe(2);

    // Give a short window for a buggy active-refetch of catalogs to show up.
    await settle(20);
    expect(models.fetches.count).toBe(1);
    expect(commands.fetches.count).toBe(1);

    // NOT invalidated - see the next test for why the flag itself matters.
    expect(queryClient.getQueryState(listModelsKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(listCommandsKey)?.isInvalidated).toBe(
      false,
    );
    // Control refetched successfully, so the invalidation flag clears.
    expect(queryClient.getQueryState(controlKey)?.isInvalidated).toBe(false);
  });

  // Codex review, PR #977 thread PRRT_kwDOL6Tbrc6WdeIO: "Do not invalidate
  // cache-only catalog queries during recovery". Marking them stale without
  // a refetch is not enough - TanStack treats an invalidated query as stale
  // regardless of `staleTime`, so the storm is deferred to the next mount,
  // not prevented. The picker creates one enabled `listModels` observer per
  // harness on open, so that mount is where all ~14 probes would land.
  // This is the load-bearing half of the argument, pinned in-suite because it
  // is the non-obvious part: `staleTime: Infinity` does NOT protect a query
  // that carries `isInvalidated`. `Query.isStaleByTime` returns true on the
  // invalidated flag BEFORE it ever consults the time budget
  // (query-core 5.101.4, `query.js:134`), and `shouldFetchOnMount` routes
  // through exactly that. So "mark stale without refetching" only moves the
  // fan-out to the next mount. The test above asserts the sweep leaves the
  // flag off; this one shows what that flag would have cost.
  it("an invalidated cache-only entry DOES refetch on the next mount (the cost the carve-out avoids)", async () => {
    const queryClient = createAppQueryClient();

    const models = mountCountedQuery(queryClient, listModelsKey, {
      staleTime: Infinity,
      impl: () => Promise.resolve({ models: ["a"] }),
    });
    stops.push(models.stop);
    await waitUntil(() => models.fetches.count === 1);

    // Control mount with the entry still clean: cache-only means no fetch.
    models.stop();
    const clean = mountCountedQuery(queryClient, listModelsKey, {
      staleTime: Infinity,
      impl: () => Promise.resolve({ models: ["a"] }),
    });
    stops.push(clean.stop);
    await settle(30);
    expect(clean.fetches.count).toBe(0);

    // Now flag it exactly as a `refetchType: "none"` sweep would have, and
    // remount: the picker re-probes despite staleTime: Infinity.
    clean.stop();
    await queryClient.invalidateQueries({
      queryKey: listModelsKey,
      refetchType: "none",
    });
    expect(queryClient.getQueryState(listModelsKey)?.isInvalidated).toBe(true);

    const afterInvalidation = mountCountedQuery(queryClient, listModelsKey, {
      staleTime: Infinity,
      impl: () => Promise.resolve({ models: ["a"] }),
    });
    stops.push(afterInvalidation.stop);
    await waitUntil(() => afterInvalidation.fetches.count === 1);
    expect(afterInvalidation.fetches.count).toBe(1);
  });

  it("with refetchActive: false, marks every host-scoped query stale without refetching", async () => {
    const queryClient = createAppQueryClient();
    const invalidator = createHostQueryInvalidator(queryClient);

    const models = mountCountedQuery(queryClient, listModelsKey, {
      staleTime: Infinity,
      impl: () => Promise.resolve({ models: ["a"] }),
    });
    const commands = mountCountedQuery(queryClient, listCommandsKey, {
      staleTime: Infinity,
      impl: () => Promise.resolve({ commands: ["c"] }),
    });
    const control = mountCountedQuery(queryClient, controlKey, {
      staleTime: 0,
      impl: () => Promise.resolve({ capabilities: [] }),
    });
    stops.push(models.stop, commands.stop, control.stop);

    await waitUntil(() => models.fetches.count === 1);
    await waitUntil(() => commands.fetches.count === 1);
    await waitUntil(() => control.fetches.count === 1);

    invalidator.invalidateHostScope(HOST_ID, { refetchActive: false });

    await settle(20);
    expect(models.fetches.count).toBe(1);
    expect(commands.fetches.count).toBe(1);
    expect(control.fetches.count).toBe(1);

    expect(queryClient.getQueryState(listModelsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(listCommandsKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(controlKey)?.isInvalidated).toBe(true);
  });

  it("with refetchActive: true, does not refetch a cloud epic-tasks key while still refetching an ordinary host key", async () => {
    // The bind-path force-refetch is the broadest host-scope sweep; force-
    // refetching the cloud epic-tasks history drops optimistically-inserted
    // local-first epics (cloud-query-keys.ts). This pin is the bind-path
    // enforcement of that documented invariant.
    const queryClient = createAppQueryClient();
    const invalidator = createHostQueryInvalidator(queryClient);

    const epicTasksKey = queryKeys.cloudEpicTasks(HOST_ID, "fingerprint-1", {
      limit: 20,
      filters: null,
      sort: "recent",
      extensionPhaseVersion: "1.0.0",
      extensionEpicVersion: "1.0.0",
    });
    const epicTasks = mountCountedQuery(queryClient, epicTasksKey, {
      staleTime: Infinity,
      impl: () =>
        Promise.resolve({
          tasks: [],
          nextCursor: undefined,
          hasMore: false,
        }),
    });
    const control = mountCountedQuery(queryClient, controlKey, {
      staleTime: 0,
      impl: () => Promise.resolve({ capabilities: [] }),
    });
    stops.push(epicTasks.stop, control.stop);

    await waitUntil(() => epicTasks.fetches.count === 1);
    await waitUntil(() => control.fetches.count === 1);

    invalidator.invalidateHostScope(HOST_ID, {
      refetchActive: true,
      recovery: "reconnect",
    });

    await waitUntil(() => control.fetches.count === 2);
    expect(control.fetches.count).toBe(2);

    await settle(20);
    expect(epicTasks.fetches.count).toBe(1);
    expect(queryClient.getQueryState(epicTasksKey)?.isInvalidated).toBe(false);
  });

  it("does not auto-refetch an errored catalog on refetchActive: true; intent edge recovers it", async () => {
    // Accepted trade-off for the same-host transport-rebind edge (also
    // refetchActive: true): an error-state catalog is marked stale without a
    // recovery fetch, so a rebind/flap cannot re-open the #912 CLI storm.
    // Recovery is intentional — harnessCatalogEntryNeedsRefresh treats isError
    // as always-due, and an intent-edge refetch (picker open / selection)
    // clears the stranded entry.
    const queryClient = createAppQueryClient();
    const invalidator = createHostQueryInvalidator(queryClient);

    const models = mountCountedQuery(queryClient, listModelsKey, {
      staleTime: Infinity,
      impl: () => Promise.reject(new Error("catalog probe failed")),
    });
    const control = mountCountedQuery(queryClient, controlKey, {
      staleTime: 0,
      impl: () => Promise.resolve({ capabilities: [] }),
    });
    stops.push(models.stop, control.stop);

    await waitUntil(() => models.fetches.count === 1);
    await waitUntil(
      () => queryClient.getQueryState(listModelsKey)?.status === "error",
    );
    await waitUntil(() => control.fetches.count === 1);
    expect(queryClient.getQueryState(listModelsKey)?.error).toBeTruthy();

    invalidator.invalidateHostScope(HOST_ID, {
      refetchActive: true,
      recovery: "reconnect",
    });

    await waitUntil(() => control.fetches.count === 2);
    expect(control.fetches.count).toBe(2);

    await settle(20);
    // Carve-out holds even when the catalog entry is already in error: no
    // automatic recovery fetch on the active host-scope sweep. The unchanged
    // fetch count is the whole probe here - note that `isInvalidated` below
    // is NOT evidence of anything the invalidator did: a query comes out of a
    // REJECTED fetch already flagged invalidated by TanStack itself, before
    // any `invalidateQueries` call (verified directly). It is asserted only
    // to pin that pre-existing shape, and it is exactly why the successful
    // catalogs in the tests above - where the flag does mean something - are
    // the ones that discriminate the carve-out.
    expect(models.fetches.count).toBe(1);
    expect(queryClient.getQueryState(listModelsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(listModelsKey)?.status).toBe("error");

    // Intent edge: flip the probe to succeed and refetch (picker open /
    // harnessCatalogEntryNeedsRefresh path). Entry recovers.
    models.setImpl(() =>
      Promise.resolve({
        harnessId: "claude",
        models: [{ id: "m1", label: "Model 1" }],
      }),
    );
    await models.observer.refetch();

    await waitUntil(
      () => queryClient.getQueryState(listModelsKey)?.status === "success",
    );
    expect(models.fetches.count).toBe(2);
    expect(queryClient.getQueryState(listModelsKey)?.error).toBeNull();
    expect(queryClient.getQueryState(listModelsKey)?.data).toEqual({
      harnessId: "claude",
      models: [{ id: "m1", label: "Model 1" }],
    });
  });
});

/**
 * G4: what a recovery sweep re-asks. A read whose current attempt is in flight
 * and has not failed is left to answer; a read that failed is re-asked by
 * every sweep; a settled read is re-asked after a reconnect and left alone
 * after a stall. Every case runs the real invalidator against the app's own
 * `QueryClient` with real observers, so "re-asked" is a real second fetch.
 */
describe("createHostQueryInvalidator / what a recovery sweep re-asks", () => {
  const stops: Array<() => void> = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) {
      stop();
    }
  });

  it.each(["stall", "reconnect"] as const)(
    "a %s sweep neither cancels nor re-issues a read still on its first attempt",
    async (recovery) => {
      const queryClient = createAppQueryClient();
      const invalidator = createHostQueryInvalidator(queryClient);
      const answer = deferred();
      const read = mountCountedQuery(queryClient, controlKey, {
        staleTime: 0,
        impl: () => answer.promise,
      });
      stops.push(read.stop);
      await waitUntil(() => read.fetches.count === 1);
      expect(queryClient.getQueryState(controlKey)?.fetchStatus).toBe(
        "fetching",
      );

      invalidator.invalidateHostScope(HOST_ID, {
        refetchActive: true,
        recovery,
      });
      await settle(20);

      // Not re-issued, and not even marked stale.
      expect(read.fetches.count).toBe(1);
      expect(queryClient.getQueryState(controlKey)?.isInvalidated).toBe(false);
      // Not cancelled either: the attempt already in flight is the one whose
      // answer lands. A cancel would have dropped it and left the read pending.
      answer.resolve({ capabilities: ["kept"] });
      await waitUntil(
        () => queryClient.getQueryState(controlKey)?.status === "success",
      );
      expect(queryClient.getQueryData(controlKey)).toEqual({
        capabilities: ["kept"],
      });
      expect(read.fetches.count).toBe(1);
    },
  );

  it("a reconnect sweep leaves a settled read's in-flight refetch alone too", async () => {
    const queryClient = createAppQueryClient();
    const invalidator = createHostQueryInvalidator(queryClient);
    const read = mountCountedQuery(queryClient, controlKey, {
      staleTime: 0,
      impl: () => Promise.resolve({ capabilities: ["first"] }),
    });
    stops.push(read.stop);
    await waitUntil(
      () => queryClient.getQueryState(controlKey)?.status === "success",
    );

    const answer = deferred();
    read.setImpl(() => answer.promise);
    void read.observer.refetch();
    await waitUntil(() => read.fetches.count === 2);

    // A reconnect re-asks every SETTLED read. This one has data, but its
    // current attempt is in flight and has not failed, so it is not settled.
    invalidator.invalidateHostScope(HOST_ID, {
      refetchActive: true,
      recovery: "reconnect",
    });
    await settle(20);
    expect(read.fetches.count).toBe(2);

    answer.resolve({ capabilities: ["second"] });
    await waitUntil(() => {
      const data: unknown = queryClient.getQueryData(controlKey);
      return (
        JSON.stringify(data) === JSON.stringify({ capabilities: ["second"] })
      );
    });
    expect(read.fetches.count).toBe(2);
  });

  it("a stall sweep leaves a read that failed alone while its next attempt is in flight", async () => {
    const queryClient = createAppQueryClient();
    const invalidator = createHostQueryInvalidator(queryClient);
    const read = mountCountedQuery(queryClient, controlKey, {
      staleTime: 0,
      impl: () => Promise.resolve({ capabilities: ["first"] }),
    });
    stops.push(read.stop);
    await waitUntil(
      () => queryClient.getQueryState(controlKey)?.status === "success",
    );
    // A background refetch fails, so the read is `error` with its data kept.
    read.setImpl(() => Promise.reject(new Error("host stalled")));
    await read.observer.refetch();
    expect(queryClient.getQueryState(controlKey)?.status).toBe("error");

    const answer = deferred();
    read.setImpl(() => answer.promise);
    void read.observer.refetch();
    await waitUntil(() => read.fetches.count === 3);
    // Still `error` - a query with data keeps its status until an attempt
    // settles - but the attempt now in flight has not failed. A stall sweep
    // reaches failed reads, and this is the one it has to leave alone.
    expect(queryClient.getQueryState(controlKey)).toMatchObject({
      status: "error",
      fetchStatus: "fetching",
      fetchFailureCount: 0,
    });

    invalidator.invalidateHostScope(HOST_ID, {
      refetchActive: true,
      recovery: "stall",
    });
    await settle(20);
    expect(read.fetches.count).toBe(3);

    answer.resolve({ capabilities: ["recovered"] });
    await waitUntil(
      () => queryClient.getQueryState(controlKey)?.status === "success",
    );
    expect(read.fetches.count).toBe(3);
  });

  it.each(["stall", "reconnect"] as const)(
    "a %s sweep cancels a read parked in retry backoff and re-issues it at once",
    async (recovery) => {
      const queryClient = createAppQueryClient();
      const invalidator = createHostQueryInvalidator(queryClient);
      const key = capabilitiesKey("/backoff");
      // One failure, then a retry TanStack would not start for a minute: the
      // read sits in backoff as `fetching` with one failure counted.
      const read = mountRetryingQuery(queryClient, key, {
        retryDelayMs: 60_000,
        impl: (attempt) =>
          attempt === 1
            ? Promise.reject(new Error("transport dropped"))
            : Promise.resolve({ capabilities: ["retried"] }),
      });
      stops.push(read.stop);
      await waitUntil(() => {
        const state = queryClient.getQueryState(key);
        return (
          state?.fetchStatus === "fetching" && state.fetchFailureCount === 1
        );
      });
      expect(read.fetches.count).toBe(1);

      invalidator.invalidateHostScope(HOST_ID, {
        refetchActive: true,
        recovery,
      });

      // Re-issued by the sweep, not by the backoff timer a minute away.
      await waitUntil(() => read.fetches.count === 2);
      await waitUntil(
        () => queryClient.getQueryState(key)?.status === "success",
      );
      expect(queryClient.getQueryData(key)).toEqual({
        capabilities: ["retried"],
      });
    },
  );

  it.each(["stall", "reconnect"] as const)(
    "a %s sweep re-issues a read that failed",
    async (recovery) => {
      const queryClient = createAppQueryClient();
      const invalidator = createHostQueryInvalidator(queryClient);
      const read = mountCountedQuery(queryClient, controlKey, {
        staleTime: 0,
        impl: () => Promise.reject(new Error("host stalled")),
      });
      stops.push(read.stop);
      await waitUntil(
        () => queryClient.getQueryState(controlKey)?.status === "error",
      );
      expect(queryClient.getQueryState(controlKey)?.fetchStatus).toBe("idle");

      read.setImpl(() => Promise.resolve({ capabilities: ["recovered"] }));
      invalidator.invalidateHostScope(HOST_ID, {
        refetchActive: true,
        recovery,
      });

      await waitUntil(() => read.fetches.count === 2);
      await waitUntil(
        () => queryClient.getQueryState(controlKey)?.status === "success",
      );
    },
  );

  it("a stall sweep leaves a settled read alone", async () => {
    const queryClient = createAppQueryClient();
    const invalidator = createHostQueryInvalidator(queryClient);
    const read = mountCountedQuery(queryClient, controlKey, {
      staleTime: 0,
      impl: () => Promise.resolve({ capabilities: [] }),
    });
    stops.push(read.stop);
    await waitUntil(
      () => queryClient.getQueryState(controlKey)?.status === "success",
    );

    invalidator.invalidateHostScope(HOST_ID, {
      refetchActive: true,
      recovery: "stall",
    });
    await settle(20);

    // The socket survived, so the process that answered this read is the one
    // answering now: nothing to re-ask, and nothing to mark stale.
    expect(read.fetches.count).toBe(1);
    expect(queryClient.getQueryState(controlKey)?.isInvalidated).toBe(false);
  });

  it("a reconnect sweep re-issues a settled read", async () => {
    const queryClient = createAppQueryClient();
    const invalidator = createHostQueryInvalidator(queryClient);
    const read = mountCountedQuery(queryClient, controlKey, {
      staleTime: 0,
      impl: () => Promise.resolve({ capabilities: [] }),
    });
    stops.push(read.stop);
    await waitUntil(
      () => queryClient.getQueryState(controlKey)?.status === "success",
    );

    invalidator.invalidateHostScope(HOST_ID, {
      refetchActive: true,
      recovery: "reconnect",
    });

    // The host may have restarted behind the new socket.
    await waitUntil(() => read.fetches.count === 2);
  });

  it("logs each sweep with its kind and the reads it left in flight", async () => {
    const infoSpy = vi.spyOn(appLogger, "info");
    const answer = deferred();
    try {
      const queryClient = createAppQueryClient();
      const invalidator = createHostQueryInvalidator(queryClient);
      const inFlight = mountCountedQuery(
        queryClient,
        capabilitiesKey("/in-flight"),
        { staleTime: 0, impl: () => answer.promise },
      );
      const failed = mountCountedQuery(
        queryClient,
        capabilitiesKey("/failed"),
        { staleTime: 0, impl: () => Promise.reject(new Error("stalled")) },
      );
      const settledRead = mountCountedQuery(
        queryClient,
        capabilitiesKey("/settled"),
        { staleTime: 0, impl: () => Promise.resolve({ capabilities: [] }) },
      );
      stops.push(inFlight.stop, failed.stop, settledRead.stop);
      await waitUntil(
        () =>
          inFlight.fetches.count === 1 &&
          queryClient.getQueryState(capabilitiesKey("/failed"))?.status ===
            "error" &&
          queryClient.getQueryState(capabilitiesKey("/settled"))?.status ===
            "success",
      );

      invalidator.invalidateHostScope(HOST_ID, {
        refetchActive: true,
        recovery: "stall",
      });

      const sweeps = infoSpy.mock.calls.filter(
        ([message]) => message === "[stream] host-scope sweep",
      );
      expect(sweeps).toEqual([
        [
          "[stream] host-scope sweep",
          { hostId: HOST_ID, recovery: "stall", refetching: 1, inFlight: 1 },
        ],
      ]);
    } finally {
      answer.resolve({ capabilities: [] });
      infoSpy.mockRestore();
    }
  });
});

type FetchImpl = () => Promise<unknown>;

function mountCountedQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  options: {
    readonly staleTime: number;
    readonly impl: FetchImpl;
  },
): {
  readonly fetches: { count: number };
  readonly observer: QueryObserver<unknown, Error, unknown, unknown>;
  readonly setImpl: (impl: FetchImpl) => void;
  readonly stop: () => void;
} {
  const fetches = { count: 0 };
  let impl: FetchImpl = options.impl;
  // Named function (not an inline queryFn) so @tanstack/query/exhaustive-deps
  // doesn't demand the test's fetch counter in the queryKey - the counter is
  // observation instrumentation, not query input.
  const countingQueryFn = (): Promise<unknown> => {
    fetches.count += 1;
    return impl();
  };
  const observer = new QueryObserver(queryClient, {
    queryKey,
    staleTime: options.staleTime,
    retry: false,
    queryFn: countingQueryFn,
  });
  const stop = observer.subscribe(() => undefined);
  return {
    fetches,
    observer,
    setImpl: (next: FetchImpl) => {
      impl = next;
    },
    stop,
  };
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for query state");
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Another non-exempt host-scoped key, one per `runningDir`. */
function capabilitiesKey(runningDir: string): QueryKey {
  return queryKeys.hostMethod<HostRpcRegistry, "git.getCapabilities">(
    HOST_ID,
    "git.getCapabilities",
    { hostId: HOST_ID, runningDir, ignoreWhitespace: false },
  );
}

function deferred(): {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
} {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((settleWith) => {
    resolve = settleWith;
  });
  return { promise, resolve };
}

/**
 * `mountCountedQuery` with one TanStack retry after `retryDelayMs`, so a read
 * can be parked in retry backoff. `impl` receives the 1-based attempt number.
 */
function mountRetryingQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
  options: {
    readonly retryDelayMs: number;
    readonly impl: (attempt: number) => Promise<unknown>;
  },
): {
  readonly fetches: { count: number };
  readonly stop: () => void;
} {
  const fetches = { count: 0 };
  const countingQueryFn = (): Promise<unknown> => {
    fetches.count += 1;
    return options.impl(fetches.count);
  };
  const observer = new QueryObserver(queryClient, {
    queryKey,
    staleTime: 0,
    retry: 1,
    retryDelay: options.retryDelayMs,
    queryFn: countingQueryFn,
  });
  const stop = observer.subscribe(() => undefined);
  return { fetches, stop };
}
