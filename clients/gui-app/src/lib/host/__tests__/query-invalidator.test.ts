import { afterEach, describe, expect, it } from "vitest";
import {
  QueryObserver,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
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

    invalidator.invalidateHostScope(HOST_ID, { refetchActive: true });

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

    invalidator.invalidateHostScope(HOST_ID, { refetchActive: true });

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

    invalidator.invalidateHostScope(HOST_ID, { refetchActive: true });

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
