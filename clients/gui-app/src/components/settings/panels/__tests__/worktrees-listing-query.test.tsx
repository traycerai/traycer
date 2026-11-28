import { afterEach, describe, expect, it, vi } from "vitest";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV16 } from "@traycer/protocol/host/worktree-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { perPathEnrichmentQueryKey } from "@/components/settings/panels/worktrees-enrichment-batcher";
import {
  SETTINGS_WORKTREE_LIST_PAGE_LIMIT,
  listingQueryKeyFor,
  useRefetchListingForVerifiedRows,
  useWorktreeListing,
} from "@/components/settings/panels/worktrees-listing-query";
import {
  persistWorktreeListingSnapshot,
  readWorktreeListingSnapshot,
} from "@/components/settings/panels/worktrees-enrichment-persistence";

const redialRemoteSessionsFor = vi.hoisted(() => vi.fn());
vi.mock(
  "@traycer-clients/shared/host-transport/remote/active-remote-sessions",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-transport/remote/active-remote-sessions")
    >()),
    redialRemoteSessionsFor,
  }),
);

// The listing hook reads/writes the warm-open listing snapshot in
// localStorage on every mount - a snapshot leaked by one test would seed the
// next test's listing and skew its assertions.
afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
  redialRemoteSessionsFor.mockReset();
  cleanup();
});

const HOST_ID = mockLocalHostEntry.hostId;
const PAGE_LIMIT = SETTINGS_WORKTREE_LIST_PAGE_LIMIT;

function listedEntry(
  worktreePath: string,
  branch: string,
): WorktreeHostEntryV16 {
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
    presence: "present",
    gitUnreadable: false,
  };
}

function fleet(count: number, prefix: string): WorktreeHostEntryV16[] {
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
  liveEntries: () => readonly WorktreeHostEntryV16[],
  onRequest: ((cursor: string | null) => void) | null,
  requestGate: ((cursor: string | null) => Promise<void>) | null,
) {
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
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
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
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
  function sentinelEntry(worktreePath: string): WorktreeHostEntryV16 {
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
        readonly worktrees: readonly WorktreeHostEntryV16[];
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

  it("redials the host before asking again for the page a partial listing failed on", async () => {
    const live = fleet(PAGE_LIMIT + 8, "live");
    const cursors: (string | null)[] = [];
    // A dial that never reached the host: the query layer does not retry it,
    // so the walk stops partial on its first failure.
    let secondPageUnreachable = true;
    let requestsAtRedial: number | null = null;
    redialRemoteSessionsFor.mockImplementation(() => {
      requestsAtRedial = cursors.length;
    });
    const fixture = createFixture(
      () => live,
      (cursor) => {
        cursors.push(cursor);
      },
      (cursor) =>
        cursor !== null && secondPageUnreachable
          ? Promise.reject(
              new RetryableTransportError({
                requestId: "req-1",
                method: "worktree.listAllForHost",
                code: "RPC_ERROR",
                message: "dial failed",
                fatalDetails: null,
                replaySafetyFromKey: false,
              }),
            )
          : Promise.resolve(),
    );
    const { result } = renderHook(
      () => useWorktreeListing(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(result.current.isPartial).toBe(true);
    });
    expect(redialRemoteSessionsFor).not.toHaveBeenCalled();
    const requestsBeforeRetry = cursors.length;
    secondPageUnreachable = false;

    await act(async () => {
      await result.current.retryPartial();
    });

    expect(redialRemoteSessionsFor.mock.calls).toEqual([
      [HOST_ID, "user-retry"],
    ]);
    expect(requestsAtRedial).toBe(requestsBeforeRetry);
    await waitFor(() => {
      expect(result.current.worktrees).toHaveLength(PAGE_LIMIT + 8);
    });
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

    const overlayKey = perPathEnrichmentQueryKey(HOST_ID, "/wt/a");
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

describe("useRefetchListingForVerifiedRows", () => {
  const PATH = "/wt/a";
  const NO_SEEDED_PATHS: ReadonlySet<string> = new Set();

  interface ListingFixture {
    readonly client: HostClient<HostRpcRegistry>;
    readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
    readonly queryClient: QueryClient;
  }

  function unresolvedEntry(): WorktreeHostEntryV16 {
    return { ...listedEntry(PATH, "feat"), resolvedAt: null };
  }

  function overlayResolvedAt(
    resolvedAt: number,
  ): ReadonlyMap<string, WorktreeHostEntryV16> {
    return new Map([[PATH, { ...listedEntry(PATH, "feat"), resolvedAt }]]);
  }

  function renderListingWithRefetch(
    fixture: ListingFixture,
    initialProps: {
      readonly reachable: boolean;
      readonly overlay: ReadonlyMap<string, WorktreeHostEntryV16>;
      readonly seededPaths: ReadonlySet<string>;
    },
  ) {
    return renderHook(
      (props: typeof initialProps) => {
        const listing = useWorktreeListing(fixture.client, true);
        useRefetchListingForVerifiedRows({
          hostId: HOST_ID,
          reachable: props.reachable,
          worktrees: listing.worktrees,
          enrichedByPath: props.overlay,
          seededPaths: props.seededPaths,
          listingSettled: listing.isSettled,
        });
        return listing;
      },
      { wrapper: fixture.Wrapper, initialProps },
    );
  }

  function listingIsIdle(fixture: ListingFixture): boolean {
    return (
      fixture.queryClient.getQueryState(listingQueryKeyFor(HOST_ID))
        ?.fetchStatus === "idle"
    );
  }

  it("re-reads a listing row the host first answered unresolved once its overlay is verified", async () => {
    let requests = 0;
    const fixture = createFixture(
      () => [requests >= 2 ? listedEntry(PATH, "feat") : unresolvedEntry()],
      () => {
        requests += 1;
      },
      null,
    );
    const { result } = renderListingWithRefetch(fixture, {
      reachable: true,
      overlay: overlayResolvedAt(5),
      seededPaths: NO_SEEDED_PATHS,
    });

    await waitFor(() => {
      expect(result.current.worktrees.map((row) => row.resolvedAt)).toEqual([
        1,
      ]);
    });
    expect(requests).toBe(2);
  });

  it("requests the listing once per overlay resolvedAt while the host keeps the row unresolved", async () => {
    let requests = 0;
    const fixture = createFixture(
      () => [unresolvedEntry()],
      () => {
        requests += 1;
      },
      null,
    );
    const { rerender } = renderListingWithRefetch(fixture, {
      reachable: true,
      overlay: overlayResolvedAt(5),
      seededPaths: NO_SEEDED_PATHS,
    });
    await waitFor(() => {
      expect(requests).toBe(2);
      expect(listingIsIdle(fixture)).toBe(true);
    });

    rerender({
      reachable: true,
      overlay: overlayResolvedAt(5),
      seededPaths: NO_SEEDED_PATHS,
    });
    await act(async () => {});
    await waitFor(() => {
      expect(listingIsIdle(fixture)).toBe(true);
    });
    expect(requests).toBe(2);

    rerender({
      reachable: true,
      overlay: overlayResolvedAt(6),
      seededPaths: NO_SEEDED_PATHS,
    });
    await waitFor(() => {
      expect(requests).toBe(3);
      expect(listingIsIdle(fixture)).toBe(true);
    });
  });

  it("requests nothing for a snapshot-seeded path or an unreachable host, and does once neither guard holds", async () => {
    let requests = 0;
    const fixture = createFixture(
      () => [unresolvedEntry()],
      () => {
        requests += 1;
      },
      null,
    );
    const overlay = overlayResolvedAt(5);
    const { rerender } = renderListingWithRefetch(fixture, {
      reachable: true,
      overlay,
      seededPaths: new Set([PATH]),
    });
    await waitFor(() => {
      expect(requests).toBe(1);
      expect(listingIsIdle(fixture)).toBe(true);
    });
    await act(async () => {});
    await waitFor(() => {
      expect(listingIsIdle(fixture)).toBe(true);
    });
    expect(requests).toBe(1);

    rerender({ reachable: false, overlay, seededPaths: NO_SEEDED_PATHS });
    await act(async () => {});
    await waitFor(() => {
      expect(listingIsIdle(fixture)).toBe(true);
    });
    expect(requests).toBe(1);

    rerender({ reachable: true, overlay, seededPaths: NO_SEEDED_PATHS });
    await waitFor(() => {
      expect(requests).toBe(2);
    });
  });
  it("waits for every page before re-reading, so a verified row on the first page does not strand the walk", async () => {
    const total = PAGE_LIMIT + 3;
    const firstPath = "/wt/walk-0";
    let walkReachedSecondPage = false;
    const secondPageGate = deferred();
    const fixture = createFixture(
      () =>
        fleet(total, "walk").map((entry) =>
          entry.worktreePath === firstPath && !walkReachedSecondPage
            ? { ...entry, resolvedAt: null }
            : entry,
        ),
      (cursor) => {
        if (cursor !== null) walkReachedSecondPage = true;
      },
      (cursor) =>
        cursor === null ? Promise.resolve() : secondPageGate.promise,
    );
    const { result } = renderListingWithRefetch(fixture, {
      reachable: true,
      overlay: new Map([[firstPath, listedEntry(firstPath, "feat-walk-0")]]),
      seededPaths: NO_SEEDED_PATHS,
    });

    await waitFor(() => {
      expect(walkReachedSecondPage).toBe(true);
      expect(result.current.worktrees).toHaveLength(PAGE_LIMIT);
    });
    act(() => {
      secondPageGate.resolve();
    });

    await waitFor(() => {
      expect(result.current.worktrees).toHaveLength(total);
      expect(result.current.worktrees[0].resolvedAt).not.toBeNull();
    });
  });
});
