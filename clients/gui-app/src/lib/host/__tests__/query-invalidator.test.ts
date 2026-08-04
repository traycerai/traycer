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

  it("with refetchActive: true, refetches non-catalog host queries but only marks catalog methods stale", async () => {
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

    expect(queryClient.getQueryState(listModelsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(listCommandsKey)?.isInvalidated).toBe(
      true,
    );
    // Control refetched successfully, so the invalidation flag clears.
    expect(queryClient.getQueryState(controlKey)?.isInvalidated).toBe(false);
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
    // automatic recovery fetch on the active host-scope sweep.
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
