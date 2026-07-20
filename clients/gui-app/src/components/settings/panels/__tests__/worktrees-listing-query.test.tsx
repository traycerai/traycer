import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV14 } from "@traycer/protocol/host/worktree-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  SETTINGS_WORKTREE_LIST_PAGE_LIMIT,
  listingQueryKeyFor,
  useWorktreeListing,
} from "@/components/settings/panels/worktrees-listing-query";
import {
  persistWorktreeListingSnapshot,
  readWorktreeListingSnapshot,
} from "@/components/settings/panels/worktrees-enrichment-persistence";

// The listing hook reads/writes the warm-open listing snapshot in
// localStorage on every mount - a snapshot leaked by one test would seed the
// next test's listing and skew its assertions.
afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
  cleanup();
});

const HOST_ID = mockLocalHostEntry.hostId;
const PAGE_LIMIT = SETTINGS_WORKTREE_LIST_PAGE_LIMIT;

function listedEntry(
  worktreePath: string,
  branch: string,
): WorktreeHostEntryV14 {
  return {
    worktreePath,
    branch,
    repoLabel: "acme/app",
    repoIdentifier: { owner: "acme", repo: "app" },
    inUse: false,
    uncommittedCount: 0,
    gitRemovable: true,
    scripts: null,
    owners: [],
    lastActivityAt: null,
    branchStatus: null,
    createdAt: null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: 1,
  };
}

function fleet(count: number, prefix: string): WorktreeHostEntryV14[] {
  return Array.from({ length: count }, (_, i) =>
    listedEntry(`/wt/${prefix}-${String(i)}`, `feat-${prefix}-${String(i)}`),
  );
}

// A hand-rolled deferred: the executor runs synchronously, so `resolve` is
// always the real resolver by construction (initialized to a no-op only to
// satisfy definite assignment).
function deferred(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A paged `worktree.listAllForHost` handler over a LIVE array reference (the
// test mutates it to model the fleet changing between runs), with an optional
// per-request gate so a test can hold pages in flight.
function createFixture(
  liveEntries: () => readonly WorktreeHostEntryV14[],
  onRequest: ((cursor: string | null) => void) | null,
  requestGate: ((cursor: string | null) => Promise<void>) | null,
) {
  const queryClient = createAppQueryClient();
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "worktree.listAllForHost": async (params) => {
          const cursor = "cursor" in params ? params.cursor : null;
          if (onRequest !== null) onRequest(cursor);
          if (requestGate !== null) await requestGate(cursor);
          const entries = liveEntries();
          const start = cursor === null ? 0 : Number(cursor);
          const limit =
            "limit" in params && params.limit !== null
              ? params.limit
              : entries.length;
          const end = Math.min(start + limit, entries.length);
          return {
            worktrees: [...entries.slice(start, end)],
            nextCursor: end < entries.length ? String(end) : null,
          };
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, Wrapper, queryClient };
}

describe("listing snapshot sentinel guard (cold-host clobber regression)", () => {
  // The base listing is deliberately non-spawning, so against a cold host it
  // answers entirely in `unresolvedRow` sentinels (`resolvedAt: null`, unknown
  // branch). Persisting those replaced a good snapshot with a fleet of
  // "detached HEAD" rows, which then restored on the next launch - the failure
  // seen live, where all 54 rows went unknown and stayed that way.
  function sentinelEntry(worktreePath: string): WorktreeHostEntryV14 {
    return {
      ...listedEntry(worktreePath, "feat"),
      branch: null,
      gitRemovable: false,
      resolvedAt: null,
    };
  }

  it("never lets unresolved rows overwrite resolved ones, but still drops de-listed rows", () => {
    persistWorktreeListingSnapshot({
      hostId: HOST_ID,
      entries: [
        listedEntry("/wt/a", "feat-a"),
        listedEntry("/wt/b", "feat-b"),
        listedEntry("/wt/gone", "feat-gone"),
      ],
      now: Date.now(),
    });

    // A cold-host listing: /wt/gone is genuinely absent, the rest are sentinels.
    persistWorktreeListingSnapshot({
      hostId: HOST_ID,
      entries: [sentinelEntry("/wt/a"), sentinelEntry("/wt/b")],
      now: Date.now(),
    });

    const snapshot = readWorktreeListingSnapshot(HOST_ID, Date.now());
    // Membership follows the incoming listing - absence is the one proof of
    // deletion - but the surviving rows keep their resolved facts.
    expect(snapshot?.entries.map((entry) => entry.worktreePath)).toEqual([
      "/wt/a",
      "/wt/b",
    ]);
    expect(snapshot?.entries.map((entry) => entry.branch)).toEqual([
      "feat-a",
      "feat-b",
    ]);
  });

  it("still lets resolved rows replace resolved rows", () => {
    persistWorktreeListingSnapshot({
      hostId: HOST_ID,
      entries: [listedEntry("/wt/a", "feat-a")],
      now: Date.now(),
    });
    persistWorktreeListingSnapshot({
      hostId: HOST_ID,
      entries: [listedEntry("/wt/a", "feat-renamed")],
      now: Date.now(),
    });

    const snapshot = readWorktreeListingSnapshot(HOST_ID, Date.now());
    expect(snapshot?.entries.map((entry) => entry.branch)).toEqual([
      "feat-renamed",
    ]);
  });

  it("seeds a first snapshot even when the host is cold", () => {
    persistWorktreeListingSnapshot({
      hostId: HOST_ID,
      entries: [sentinelEntry("/wt/a")],
      now: Date.now(),
    });

    const snapshot = readWorktreeListingSnapshot(HOST_ID, Date.now());
    expect(snapshot?.entries).toHaveLength(1);
    expect(snapshot?.entries[0]?.resolvedAt).toBeNull();
  });
});

describe("useWorktreeListing (warm-open listing snapshot)", () => {
  it("paints the last run's rows before the first page lands, then reconciles to live truth", async () => {
    const restored = [
      listedEntry("/wt/a", "feat-a"),
      listedEntry("/wt/b", "feat-b"),
      // Deleted since the snapshot was written - must drop on reconcile.
      listedEntry("/wt/gone", "feat-gone"),
    ];
    persistWorktreeListingSnapshot({
      hostId: HOST_ID,
      entries: restored,
      now: Date.now() - 60_000,
    });
    // The live fleet: /wt/gone deleted, /wt/new created since.
    const live = [
      listedEntry("/wt/a", "feat-a"),
      listedEntry("/wt/b", "feat-b"),
      listedEntry("/wt/new", "feat-new"),
    ];
    const gate = deferred();
    const fixture = createFixture(
      () => live,
      null,
      () => gate.promise,
    );
    const { result } = renderHook(
      () => useWorktreeListing(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );

    // Warm open: the row list is the snapshot, synchronously - the live
    // request is parked on the gate, so nothing has come from the host yet.
    expect(result.current.isPending).toBe(false);
    expect(result.current.worktrees.map((entry) => entry.worktreePath)).toEqual(
      ["/wt/a", "/wt/b", "/wt/gone"],
    );

    // Release the live response: the reconcile drops the deleted row and
    // picks up the new one, wholesale.
    act(() => {
      gate.resolve();
    });
    await waitFor(() => {
      expect(
        result.current.worktrees.map((entry) => entry.worktreePath),
      ).toEqual(["/wt/a", "/wt/b", "/wt/new"]);
    });
  });

  it("chunks a large snapshot at the live page limit so the reconciling refetch walks real cursors", async () => {
    const restored = fleet(PAGE_LIMIT + 8, "old");
    persistWorktreeListingSnapshot({
      hostId: HOST_ID,
      entries: restored,
      now: Date.now() - 60_000,
    });
    const live = fleet(PAGE_LIMIT + 8, "old");
    const fixture = createFixture(() => live, null, null);
    const { result } = renderHook(
      () => useWorktreeListing(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );

    // Every restored row paints, and the seed is page-shaped (chunked at the
    // live limit), not one flat page - so the refetch replaces it page by
    // page instead of collapsing the tail.
    expect(result.current.worktrees).toHaveLength(PAGE_LIMIT + 8);
    const seeded = fixture.queryClient.getQueryData<{
      readonly pages: ReadonlyArray<{
        readonly worktrees: readonly WorktreeHostEntryV14[];
      }>;
    }>(listingQueryKeyFor(HOST_ID));
    expect(seeded?.pages.map((page) => page.worktrees.length)).toEqual([
      PAGE_LIMIT,
      8,
    ]);

    // The live walk converges to the same fleet (cursors re-derived from live
    // pages - the synthetic seed cursors never reach the mock host, which
    // only understands numeric offsets).
    await waitFor(() => {
      expect(result.current.worktrees).toHaveLength(PAGE_LIMIT + 8);
      expect(result.current.isRefreshPending).toBe(false);
    });
    expect(result.current.worktrees[PAGE_LIMIT + 7].worktreePath).toBe(
      `/wt/old-${String(PAGE_LIMIT + 7)}`,
    );
  });

  it("persists only COMPLETE listings, debounced - a partial walk never snapshots", async () => {
    vi.useFakeTimers();
    const live = fleet(PAGE_LIMIT + 4, "live");
    let holdSecondPage = true;
    const secondPageGate = deferred();
    const fixture = createFixture(
      () => live,
      null,
      (cursor) =>
        cursor === null || !holdSecondPage
          ? Promise.resolve()
          : secondPageGate.promise,
    );
    renderHook(() => useWorktreeListing(fixture.client, true), {
      wrapper: fixture.Wrapper,
    });

    // Page 1 lands; page 2 is parked on the gate. Well past the persist
    // debounce, nothing may be written - the listing is a truncated prefix.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(readWorktreeListingSnapshot(HOST_ID, Date.now())).toBeNull();

    // Page 2 lands → the walk completes → the debounced write fires with the
    // full fleet in listing order.
    holdSecondPage = false;
    secondPageGate.resolve();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const snapshot = readWorktreeListingSnapshot(HOST_ID, Date.now());
    expect(snapshot?.entries).toHaveLength(PAGE_LIMIT + 4);
    expect(snapshot?.entries[0].worktreePath).toBe("/wt/live-0");
    expect(snapshot?.entries[PAGE_LIMIT + 3].worktreePath).toBe(
      `/wt/live-${String(PAGE_LIMIT + 3)}`,
    );
  });

  it("never re-persists a restored seed (a stale snapshot must not have its age extended)", async () => {
    vi.useFakeTimers();
    const savedAt = Date.now() - 60_000;
    persistWorktreeListingSnapshot({
      hostId: HOST_ID,
      entries: [listedEntry("/wt/a", "feat-a")],
      now: savedAt,
    });
    // The live request never resolves: the only data all test long is the seed.
    const fixture = createFixture(
      () => [],
      null,
      () => new Promise<void>(() => undefined),
    );
    const { result } = renderHook(
      () => useWorktreeListing(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );
    expect(result.current.worktrees).toHaveLength(1);

    // Past the debounce: the seed satisfies "complete listing" (success, no
    // next page), but it is NOT live data - the write must be skipped, so the
    // stored snapshot keeps its original savedAt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(readWorktreeListingSnapshot(HOST_ID, Date.now())?.savedAt).toBe(
      savedAt,
    );
  });

  it("discards a corrupt listing snapshot - cold open, storage cleaned up", () => {
    window.localStorage.setItem(
      `traycer-gui-app:worktree-listing-cache:${HOST_ID}`,
      "{not json",
    );
    const fixture = createFixture(
      () => [],
      null,
      () => new Promise<void>(() => undefined),
    );
    const { result } = renderHook(
      () => useWorktreeListing(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );

    expect(result.current.worktrees).toHaveLength(0);
    expect(
      window.localStorage.getItem(
        `traycer-gui-app:worktree-listing-cache:${HOST_ID}`,
      ),
    ).toBeNull();
  });
  // `forceRefresh` re-resolves the BASE rows, so every cached per-path overlay
  // is instantly older than its base row and `acceptedEnrichedByPath` rejects
  // it - the row reads "Checking...". The overlays keep their keys, so nothing
  // else re-probes them: without this invalidation the Refresh button strands
  // every on-screen row, permanently against a host with no `worktree.changed`.
  it("isRefreshPending tracks the manual refresh mutation only, not background fetches", async () => {
    // Regression: the toolbar keyed its Refresh button's disabled state off a
    // signal that also went true during background/enrichment fetching, so a
    // cold fleet still converging locked the button (and the "Updated" label)
    // out for the whole convergence.
    const live = [listedEntry("/wt/a", "main")];
    // Two gates: one holds the mount-time background page, one holds the
    // forced-refresh request, so each can be observed in flight.
    let backgroundGate: { promise: Promise<void>; resolve: () => void } | null =
      deferred();
    let refreshGate: { promise: Promise<void>; resolve: () => void } | null =
      null;
    const fixture = createFixture(
      () => live,
      null,
      async (cursor) => {
        void cursor;
        if (backgroundGate !== null) {
          await backgroundGate.promise;
          return;
        }
        if (refreshGate !== null) await refreshGate.promise;
      },
    );
    const { result } = renderHook(
      () => useWorktreeListing(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );

    // The initial page is still fetching in the background, but no manual
    // refresh has been triggered - the button must stay live.
    expect(result.current.isRefreshPending).toBe(false);
    act(() => {
      backgroundGate?.resolve();
      backgroundGate = null;
    });
    await waitFor(() => {
      expect(result.current.worktrees).toHaveLength(1);
    });
    expect(result.current.isRefreshPending).toBe(false);

    // Only the explicit Refresh mutation flips it; held in flight so `true`
    // is observable, then cleared on settle.
    refreshGate = deferred();
    let refreshDone: Promise<unknown> = Promise.resolve();
    act(() => {
      refreshDone = result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.isRefreshPending).toBe(true);
    });
    await act(async () => {
      refreshGate?.resolve();
      refreshGate = null;
      await refreshDone;
    });
    await waitFor(() => {
      expect(result.current.isRefreshPending).toBe(false);
    });
  });

  it("invalidates the per-path enrichment overlays after a forced refresh", async () => {
    const live = [listedEntry("/wt/a", "main")];
    const fixture = createFixture(() => live, null, null);
    const { result } = renderHook(
      () => useWorktreeListing(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current.worktrees).toHaveLength(1);
    });

    const overlayKey = hostQueryKeys.method(
      HOST_ID,
      "worktree.listAllForHost",
      {
        includeActivity: true,
        activityPaths: ["/wt/a"],
        cursor: null,
        limit: null,
        forceRefresh: false,
      },
    );
    fixture.queryClient.setQueryData(overlayKey, {
      worktrees: [listedEntry("/wt/a", "main")],
      nextCursor: null,
    });
    expect(fixture.queryClient.getQueryState(overlayKey)?.isInvalidated).toBe(
      false,
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(fixture.queryClient.getQueryState(overlayKey)?.isInvalidated).toBe(
      true,
    );
  });
});
