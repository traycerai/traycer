import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { WorktreeHostEntryV16 } from "@traycer/protocol/host/worktree-schemas";
import { perPathEnrichmentQueryKey } from "@/components/settings/panels/worktrees-enrichment-batcher";
import { useWorktreeEnrichmentForClient } from "@/hooks/worktree/use-worktree-enrichment-query";
import { useWorktreeHostIndexForClient } from "@/hooks/worktree/use-task-worktree-metadata-query";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { invalidateWorktreeChangedCaches } from "@/lib/worktree/invalidate-worktree-changed-caches";
import {
  isWorktreeChangedStreamCovered,
  markWorktreeChangedStreamOpen,
  markWorktreeChangedStreamClosed,
  resetWorktreeChangedCoverageForTests,
  WORKTREE_CHANGED_RECOVERY_GRACE_MS,
} from "@/lib/worktree/worktree-changed-coverage";

/**
 * Every worktree surface outside Settings reads ONE host-wide paged listing;
 * selection-mode reads are spent only on rows the listing reports unresolved.
 * A navigation or remount costs nothing while the host's `worktree.changed`
 * stream is open, and a frame costs one listing read.
 */

const HOST_ID = mockLocalHostEntry.hostId;

function row(
  worktreePath: string,
  resolvedAt: number | null,
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
    // Resolved fixture rows are settled unless a test opts in to missing
    // activity explicitly. `null` means the listing lacks PR activity facts.
    prState: "none",
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt,
    presence: "present",
    gitUnreadable: false,
  };
}

interface Host {
  /** What the paged listing answers. */
  listing: WorktreeHostEntryV16[];
  /** What a selection read answers for a path (defaults to the listing's row). */
  readonly selection: Map<string, WorktreeHostEntryV16>;
}

interface Fixture {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  readonly host: Host;
  readonly pagedCalls: () => number;
  readonly selectionCalls: string[][];
  readonly deferNextPagedResponse: () => (
    worktrees: WorktreeHostEntryV16[],
  ) => void;
  readonly deferNextSelectionResponse: () => (
    worktrees: WorktreeHostEntryV16[],
  ) => void;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

interface FixtureResponse {
  readonly worktrees: WorktreeHostEntryV16[];
  readonly nextCursor: null;
}

interface DeferredFixtureResponse {
  readonly promise: Promise<FixtureResponse>;
  readonly resolve: (response: FixtureResponse) => void;
}

function createDeferredFixtureResponse(): DeferredFixtureResponse {
  let resolve: (response: FixtureResponse) => void = () => {
    throw new Error("Deferred fixture response was not initialized");
  };
  const promise = new Promise<FixtureResponse>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createFixture(listing: WorktreeHostEntryV16[]): Fixture {
  const queryClient = createAppQueryClient();
  const host: Host = { listing, selection: new Map() };
  let paged = 0;
  const selectionCalls: string[][] = [];
  let deferredPagedResponse: DeferredFixtureResponse | null = null;
  let deferredSelectionResponse: DeferredFixtureResponse | null = null;
  const deferNextPagedResponse = () => {
    const deferred = createDeferredFixtureResponse();
    deferredPagedResponse = deferred;
    return (worktrees: WorktreeHostEntryV16[]) =>
      deferred.resolve({ worktrees, nextCursor: null });
  };
  const deferNextSelectionResponse = () => {
    const deferred = createDeferredFixtureResponse();
    deferredSelectionResponse = deferred;
    return (worktrees: WorktreeHostEntryV16[]) =>
      deferred.resolve({ worktrees, nextCursor: null });
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "worktree.listAllForHost": (params) => {
          if (params.activityPaths === null) {
            paged += 1;
            const deferred = deferredPagedResponse;
            deferredPagedResponse = null;
            if (deferred !== null) return deferred.promise;
            return Promise.resolve({
              worktrees: [...host.listing],
              nextCursor: null,
            });
          }
          selectionCalls.push([...params.activityPaths]);
          const deferred = deferredSelectionResponse;
          deferredSelectionResponse = null;
          if (deferred !== null) return deferred.promise;
          return Promise.resolve({
            worktrees: params.activityPaths.flatMap((path) => {
              const answered =
                host.selection.get(path) ??
                host.listing.find((entry) => entry.worktreePath === path);
              return answered === undefined ? [] : [answered];
            }),
            nextCursor: null,
          });
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
  return {
    queryClient,
    client,
    host,
    pagedCalls: () => paged,
    selectionCalls,
    deferNextPagedResponse,
    deferNextSelectionResponse,
    Wrapper,
  };
}

async function settle(): Promise<void> {
  // Past the batcher's coalescing window, so a queued selection read is sent.
  await new Promise((resolve) => setTimeout(resolve, 60));
}

const RESOLVED = [row("/wt/a", 10, "a"), row("/wt/b", 10, "b")];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetWorktreeChangedCoverageForTests();
});

describe("worktree metadata from one paged read per host", () => {
  it("serves the index and the enriched rows of resolved worktrees from one paged read", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a", "/wt/b"];

    const { result } = renderHook(
      () => ({
        index: useWorktreeHostIndexForClient(fixture.client, true),
        rows: useWorktreeEnrichmentForClient(
          fixture.client,
          paths,
          true,
          "none",
        ),
      }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => expect(result.current.rows.worktrees).toHaveLength(2));
    await settle();
    expect(result.current.index.worktrees).toHaveLength(2);
    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([]);
  });

  it("requests activity for resolved rows in the PR-number History index even under replay coverage", async () => {
    const fixture = createFixture([row("/wt/a", 10, "a")]);
    fixture.host.selection.set("/wt/a", {
      ...row("/wt/a", 20, "a"),
      prState: "open" as const,
      prNumber: 42,
      prUrl: "https://example.test/pull/42",
      branchStatus: { ahead: 2, behind: 0, mergedIntoDefault: false },
    });
    markWorktreeChangedStreamOpen(HOST_ID);

    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(
          fixture.client,
          ["/wt/a"],
          true,
          "always",
        ),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.worktrees[0]?.prNumber).toBe(42));
    await settle();

    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);
    expect(result.current.worktrees[0]?.prState).toBe("open");
  });

  it("reads only missing PR activity for task metadata rows and carries submodule facts", async () => {
    const missingActivity = {
      ...row("/wt/missing", 10, "listed"),
      prState: null,
    };
    const settledActivity = row("/wt/settled", 10, "settled");
    const fixture = createFixture([missingActivity, settledActivity]);
    fixture.host.selection.set("/wt/missing", {
      ...row("/wt/missing", 10, "selection"),
      prState: "open",
      prNumber: 51,
      prUrl: "https://example.test/pull/51",
      submodules: [
        {
          repoIdentifier: { owner: "acme", repo: "shared" },
          branch: "feature/shared",
          prState: "merged",
          prNumber: 52,
          prUrl: "https://example.test/shared/pull/52",
          mergedHeadShaMatches: true,
          mergedIntoDefault: true,
          atPinnedCommit: true,
          unmergedCommitCount: null,
          unmergedCommitSubjects: null,
        },
      ],
    });
    markWorktreeChangedStreamOpen(HOST_ID);

    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(
          fixture.client,
          ["/wt/missing", "/wt/settled"],
          true,
          "ifMissing",
        ),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() =>
      expect(result.current.worktrees[0]?.submodules).toHaveLength(1),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/missing"]]);
    expect(result.current.worktrees[0]).toMatchObject({
      branch: "listed",
      prState: "open",
      prNumber: 51,
      submodules: [
        {
          repoIdentifier: { owner: "acme", repo: "shared" },
          prState: "merged",
          prNumber: 52,
        },
      ],
    });
    expect(result.current.worktrees[1]?.prState).toBe("none");
  });

  it("costs nothing on remount with the host stream open and performs no resolved-row enrichment reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a"];
    const mount = () =>
      renderHook(
        () =>
          useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(1));
    first.unmount();

    vi.setSystemTime(Date.now() + 3 * 60_000);
    const second = mount();
    await waitFor(() =>
      expect(second.result.current.worktrees).toHaveLength(1),
    );
    await settle();

    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([]);
  });

  it("re-reads the listing on a remount when no stream watches the host", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = createFixture(RESOLVED);
    const paths = ["/wt/a"];
    const mount = () =>
      renderHook(
        () =>
          useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(1));
    first.unmount();

    vi.setSystemTime(Date.now() + 2 * 60_000);
    mount();
    await waitFor(() => expect(fixture.pagedCalls()).toBe(2));
  });

  it("keeps a listing covered through reconnect grace, then returns to the 60-second freshness fallback", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const mount = () =>
      renderHook(() => useWorktreeHostIndexForClient(fixture.client, true), {
        wrapper: fixture.Wrapper,
      });
    const first = mount();
    await waitFor(() => expect(first.result.current.worktrees).toHaveLength(2));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      markWorktreeChangedStreamClosed(HOST_ID);
      expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(true);
      expect(fixture.pagedCalls()).toBe(1);
      vi.setSystemTime(Date.now() + WORKTREE_CHANGED_RECOVERY_GRACE_MS);
      expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(false);
      first.unmount();
      const second = mount();
      await waitFor(() => expect(fixture.pagedCalls()).toBe(2));
      expect(second.result.current.worktrees).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches one shared mounted listing after reconnect grace expires", async () => {
    const fixture = createFixture([row("/wt/a", 10, "before reconnect")]);
    markWorktreeChangedStreamOpen(HOST_ID);
    const indexConsumer = renderHook(
      () => useWorktreeHostIndexForClient(fixture.client, true),
      { wrapper: fixture.Wrapper },
    );
    const rowConsumer = renderHook(
      () =>
        useWorktreeEnrichmentForClient(fixture.client, ["/wt/a"], true, "none"),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(indexConsumer.result.current.worktrees[0]?.branch).toBe(
        "before reconnect",
      );
      expect(rowConsumer.result.current.worktrees[0]?.branch).toBe(
        "before reconnect",
      );
    });
    expect(fixture.pagedCalls()).toBe(1);

    vi.useFakeTimers();
    try {
      markWorktreeChangedStreamClosed(HOST_ID);
      fixture.host.listing = [row("/wt/a", 20, "after grace")];
      expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_CHANGED_RECOVERY_GRACE_MS);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(30);
        await Promise.resolve();
      });
      expect(fixture.pagedCalls()).toBe(2);
      expect(indexConsumer.result.current.worktrees[0]?.branch).toBe(
        "after grace",
      );
      expect(rowConsumer.result.current.worktrees[0]?.branch).toBe(
        "after grace",
      );
      expect(fixture.pagedCalls()).toBe(2);
      expect(fixture.selectionCalls).toEqual([["/wt/a"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches a mounted missing-activity path once when replay grace expires", async () => {
    const fixture = createFixture([
      { ...row("/wt/a", 10, "a"), prState: null },
    ]);
    const selectionRow = {
      ...row("/wt/a", 10, "a"),
      prState: "open" as const,
      prNumber: 54,
      prUrl: "https://example.test/pull/54",
    };
    fixture.host.selection.set("/wt/a", selectionRow);
    markWorktreeChangedStreamOpen(HOST_ID);
    const mount = () =>
      renderHook(
        () =>
          useWorktreeEnrichmentForClient(
            fixture.client,
            ["/wt/a"],
            true,
            "ifMissing",
          ),
        { wrapper: fixture.Wrapper },
      );
    const first = mount();
    const second = mount();
    await waitFor(() =>
      expect(first.result.current.worktrees[0]?.prState).toBe("open"),
    );
    await settle();
    expect(second.result.current.worktrees[0]?.prNumber).toBe(54);
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);
    expect(fixture.pagedCalls()).toBe(1);

    vi.useFakeTimers();
    try {
      markWorktreeChangedStreamClosed(HOST_ID);
      fixture.host.selection.set("/wt/a", {
        ...selectionRow,
        prState: "merged",
        resolvedAt: 20,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_CHANGED_RECOVERY_GRACE_MS);
        await vi.advanceTimersByTimeAsync(1);
        // The path read coalesces in the enrichment batcher's 25ms window.
        await vi.advanceTimersByTimeAsync(30);
        await Promise.resolve();
      });
      vi.useRealTimers();
      expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(false);
      expect(fixture.pagedCalls()).toBe(2);
      await waitFor(() => expect(fixture.selectionCalls).toHaveLength(2));
      await waitFor(() =>
        expect(first.result.current.worktrees[0]?.prState).toBe("merged"),
      );
      expect(second.result.current.worktrees[0]?.prState).toBe("merged");
      expect(fixture.selectionCalls).toEqual([["/wt/a"], ["/wt/a"]]);
      expect(fixture.pagedCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps touching a resolved row on an unwatched host so an external PR merge appears after stale remount", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const open = {
      ...row("/wt/a", 10, "a"),
      prState: "open" as const,
      prNumber: 41,
      prUrl: "https://example.test/pull/41",
    };
    const fixture = createFixture([open]);
    fixture.host.selection.set("/wt/a", open);
    const mount = () =>
      renderHook(
        () =>
          useWorktreeEnrichmentForClient(
            fixture.client,
            ["/wt/a"],
            true,
            "none",
          ),
        { wrapper: fixture.Wrapper },
      );

    const first = mount();
    await waitFor(() =>
      expect(first.result.current.worktrees[0]?.prState).toBe("open"),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);
    first.unmount();

    fixture.host.selection.set("/wt/a", {
      ...row("/wt/a", 20, "a"),
      prState: "merged",
      prNumber: 41,
      prUrl: "https://example.test/pull/41",
    });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const second = mount();
    await waitFor(() =>
      expect(second.result.current.worktrees[0]?.prState).toBe("merged"),
    );
    await settle();
    expect(fixture.pagedCalls()).toBe(2);
    expect(fixture.selectionCalls).toEqual([["/wt/a"], ["/wt/a"]]);
  });

  it("reads only the rows the listing reports unresolved, and shows what that read derived", async () => {
    const fixture = createFixture([
      row("/wt/a", 10, "a"),
      row("/wt/cold", null, "(unresolved)"),
    ]);
    fixture.host.selection.set("/wt/cold", row("/wt/cold", 20, "derived"));
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a", "/wt/cold"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() =>
      expect(result.current.worktrees.map((entry) => entry.branch)).toEqual([
        "a",
        "derived",
      ]),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/cold"]]);
  });

  it("keeps a binding selection completed before an empty burst listing response", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const path = "/wt/binding";
    const fixture = createFixture([]);
    fixture.host.selection.set(path, row(path, 10, "initial binding"));
    markWorktreeChangedStreamOpen(HOST_ID);
    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(fixture.client, [path], true, "none"),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("initial binding"),
    );
    await settle();
    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([[path]]);

    const listingKey = hostQueryKeys.method<
      HostRpcRegistry,
      "worktree.listAllForHost"
    >(HOST_ID, "worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    });
    const listingQuery = fixture.queryClient.getQueryCache().find({
      queryKey: listingKey,
      exact: true,
    });
    expect(listingQuery).toBeDefined();
    const listingUpdateCount = listingQuery?.state.dataUpdateCount ?? 0;
    const responseTimestamp = Date.now();
    const resolveSelection = fixture.deferNextSelectionResponse();
    const resolveListing = fixture.deferNextPagedResponse();
    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: true,
        worktreePaths: new Set([path]),
      });
    });
    await waitFor(() => {
      expect(fixture.pagedCalls()).toBe(2);
      expect(fixture.selectionCalls).toHaveLength(2);
    });

    act(() => {
      vi.setSystemTime(responseTimestamp + 1);
      resolveSelection([row(path, 20, "burst selection")]);
    });
    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("burst selection"),
    );

    act(() => {
      vi.setSystemTime(responseTimestamp + 2);
      resolveListing([]);
    });
    await waitFor(() =>
      expect(listingQuery?.state.dataUpdateCount).toBeGreaterThan(
        listingUpdateCount,
      ),
    );

    // A path absent from the base listing may still be supplied by a host
    // binding. Selection succeeded during this burst; an empty listing that
    // completes second must not erase it or wait for a frame that never comes.
    expect(result.current.worktrees[0]?.branch).toBe("burst selection");
    expect(fixture.selectionCalls).toEqual([[path], [path]]);
  });

  it.each(["recreated", "reset"] as const)(
    "retries a stale selection after an empty listing query is %s with its count restarted",
    async (listingLifecycle) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const timestamp = Date.now();
      vi.setSystemTime(timestamp);
      const path = "/wt/binding";
      const fixture = createFixture([]);
      const listingKey = hostQueryKeys.method<
        HostRpcRegistry,
        "worktree.listAllForHost"
      >(HOST_ID, "worktree.listAllForHost", {
        includeActivity: false,
        activityPaths: null,
        cursor: null,
        limit: null,
        forceRefresh: false,
      });
      const selectionKey = perPathEnrichmentQueryKey(HOST_ID, path);
      fixture.queryClient.setQueryDefaults(selectionKey, {
        staleTime: Infinity,
      });
      fixture.host.selection.set(path, row(path, 10, "initial selection"));
      markWorktreeChangedStreamOpen(HOST_ID);
      const mount = () =>
        renderHook(
          () =>
            useWorktreeEnrichmentForClient(
              fixture.client,
              [path],
              true,
              "always",
            ),
          { wrapper: fixture.Wrapper },
        );

      const first = mount();
      await waitFor(() =>
        expect(first.result.current.worktrees[0]?.branch).toBe(
          "initial selection",
        ),
      );
      await settle();
      expect(fixture.pagedCalls()).toBe(1);
      expect(fixture.selectionCalls).toEqual([[path]]);

      fixture.host.selection.set(path, row(path, 20, "handled selection"));
      vi.setSystemTime(timestamp + 1);
      await act(async () => {
        await fixture.queryClient.invalidateQueries({
          queryKey: listingKey,
          exact: true,
        });
      });
      await waitFor(() =>
        expect(first.result.current.worktrees[0]?.branch).toBe(
          "handled selection",
        ),
      );
      await settle();
      expect(fixture.pagedCalls()).toBe(2);
      expect(fixture.selectionCalls).toEqual([[path], [path]]);
      first.unmount();

      let expectedBranch: string;
      if (listingLifecycle === "recreated") {
        fixture.queryClient.removeQueries({
          queryKey: listingKey,
          exact: true,
        });
        fixture.host.selection.set(path, row(path, 30, "after recreation"));
        vi.setSystemTime(timestamp + 2);
        expectedBranch = "after recreation";
      } else {
        fixture.host.selection.set(path, row(path, 30, "after reset"));
        vi.setSystemTime(timestamp + 2);
        await act(async () => {
          await fixture.queryClient.resetQueries({
            queryKey: listingKey,
            exact: true,
          });
        });
        expectedBranch = "after reset";
      }

      const second = mount();
      await waitFor(() => expect(fixture.pagedCalls()).toBe(3));
      await waitFor(() => expect(fixture.selectionCalls).toHaveLength(3));
      await waitFor(() =>
        expect(second.result.current.worktrees[0]?.branch).toBe(expectedBranch),
      );
      await settle();

      expect(fixture.pagedCalls()).toBe(3);
      expect(fixture.selectionCalls).toEqual([[path], [path], [path]]);
    },
  );

  it("shows whichever copy resolved last: a newer listing over an older selection answer", async () => {
    const fixture = createFixture([row("/wt/a", 10, "old")]);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("old"),
    );

    // The host re-derived the row and announced it: one listing read.
    fixture.host.listing = [row("/wt/a", 30, "new")];
    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: false,
        worktreePaths: new Set(["/wt/a"]),
      });
    });

    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("new"),
    );
    await settle();
    expect(fixture.pagedCalls()).toBe(2);
    expect(fixture.selectionCalls).toHaveLength(0);
  });

  it("does not resurrect a stale selection row after a successful listing removes that managed path", async () => {
    const fixture = createFixture([row("/wt/a", 10, "listed")]);
    fixture.host.selection.set("/wt/a", row("/wt/a", 20, "stale selection"));
    markWorktreeChangedStreamOpen(HOST_ID);
    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(
          fixture.client,
          ["/wt/a"],
          true,
          "always",
        ),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("stale selection"),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);

    fixture.host.listing = [];
    fixture.host.selection.delete("/wt/a");
    const baseListingKey = hostQueryKeys.method<
      HostRpcRegistry,
      "worktree.listAllForHost"
    >(HOST_ID, "worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    });
    await act(async () => {
      await fixture.queryClient.invalidateQueries({
        queryKey: baseListingKey,
        exact: true,
      });
    });
    await waitFor(() => expect(fixture.pagedCalls()).toBe(2));

    await waitFor(() => expect(fixture.selectionCalls).toHaveLength(2));
    await settle();
    expect(result.current.worktrees).toEqual([]);
  });

  it("refetches a cached binding selection after a later empty listing in the same millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const timestamp = Date.now();
    vi.setSystemTime(timestamp);
    const bindingPath = "/wt/binding";
    const fixture = createFixture([]);
    fixture.host.selection.set(
      bindingPath,
      row(bindingPath, timestamp, "binding selection"),
    );
    markWorktreeChangedStreamOpen(HOST_ID);
    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(
          fixture.client,
          [bindingPath],
          true,
          "always",
        ),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("binding selection"),
    );
    await settle();
    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([[bindingPath]]);

    const listingKey = hostQueryKeys.method<
      HostRpcRegistry,
      "worktree.listAllForHost"
    >(HOST_ID, "worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    });
    const listingQuery = fixture.queryClient.getQueryCache().find({
      queryKey: listingKey,
      exact: true,
    });
    expect(listingQuery).toBeDefined();
    const listingUpdateCount = listingQuery?.state.dataUpdateCount ?? 0;

    // A later empty response has the same Date.now() value as the cached
    // selection answer. The old answer must be refreshed automatically, even
    // though its query was otherwise fresh under stream coverage.
    fixture.host.selection.set(
      bindingPath,
      row(bindingPath, timestamp, "fresh binding selection"),
    );
    await act(async () => {
      await fixture.queryClient.invalidateQueries({
        queryKey: listingKey,
        exact: true,
      });
    });
    await waitFor(() =>
      expect(listingQuery?.state.dataUpdateCount).toBeGreaterThan(
        listingUpdateCount,
      ),
    );
    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe(
        "fresh binding selection",
      ),
    );
    await settle();
    expect(fixture.pagedCalls()).toBe(2);
    expect(fixture.selectionCalls).toEqual([[bindingPath], [bindingPath]]);
  });

  it("uses an equally timestamped cached binding selection when both query results predate the hook", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const timestamp = Date.now();
    vi.setSystemTime(timestamp);
    const bindingPath = "/wt/binding";
    const fixture = createFixture([]);
    const listingKey = hostQueryKeys.method<
      HostRpcRegistry,
      "worktree.listAllForHost"
    >(HOST_ID, "worktree.listAllForHost", {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    });
    const selectionKey = perPathEnrichmentQueryKey(HOST_ID, bindingPath);
    fixture.queryClient.setQueryData(
      listingKey,
      { worktrees: [], nextCursor: null },
      { updatedAt: timestamp },
    );
    fixture.queryClient.setQueryData(
      selectionKey,
      {
        worktrees: [row(bindingPath, timestamp, "cached binding")],
        nextCursor: null,
      },
      { updatedAt: timestamp },
    );
    markWorktreeChangedStreamOpen(HOST_ID);

    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(
          fixture.client,
          [bindingPath],
          true,
          "none",
        ),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("cached binding"),
    );
    expect(fixture.pagedCalls()).toBe(0);
    expect(fixture.selectionCalls).toEqual([]);
  });

  it("invalidates a fresh selection refreshed by another observer during grace when this consumer enables it at expiry", async () => {
    const fixture = createFixture([row("/wt/a", 10, "listed")]);
    const path = "/wt/a";
    const selectionKey = perPathEnrichmentQueryKey(HOST_ID, path);
    fixture.queryClient.setQueryDefaults(selectionKey, {
      staleTime: Infinity,
    });
    markWorktreeChangedStreamOpen(HOST_ID);
    const dormantConsumer = renderHook(
      () =>
        useWorktreeEnrichmentForClient(fixture.client, [path], true, "none"),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() =>
      expect(dormantConsumer.result.current.worktrees[0]?.branch).toBe(
        "listed",
      ),
    );
    expect(fixture.pagedCalls()).toBe(1);
    expect(fixture.selectionCalls).toEqual([]);

    vi.useFakeTimers();
    markWorktreeChangedStreamClosed(HOST_ID);
    expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(true);
    fixture.host.selection.set(path, row(path, 20, "during grace"));
    const refreshingConsumer = renderHook(
      () =>
        useWorktreeEnrichmentForClient(fixture.client, [path], true, "always"),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30);
      await Promise.resolve();
    });
    expect(fixture.selectionCalls).toEqual([[path]]);
    expect(dormantConsumer.result.current.worktrees[0]?.branch).toBe(
      "during grace",
    );
    refreshingConsumer.unmount();

    fixture.host.selection.set(path, row(path, 30, "after grace"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKTREE_CHANGED_RECOVERY_GRACE_MS + 1);
      await vi.advanceTimersByTimeAsync(30);
      await Promise.resolve();
    });

    expect(isWorktreeChangedStreamCovered(HOST_ID)).toBe(false);
    expect(fixture.selectionCalls).toEqual([[path], [path]]);
    expect(dormantConsumer.result.current.worktrees[0]?.branch).toBe(
      "after grace",
    );
    expect(fixture.pagedCalls()).toBe(2);
  });

  it("prefers a later listing's owners, inUse and scripts when resolvedAt ties the selection answer", async () => {
    const oldSelection = {
      ...row("/wt/a", 10, "selection-answer"),
      prState: "open" as const,
      prNumber: 43,
      prUrl: "https://example.test/pull/43",
      branchStatus: { ahead: 3, behind: 1, mergedIntoDefault: false },
      owners: [
        {
          epicId: "old-epic",
          ownerKind: "chat" as const,
          ownerId: "old-chat",
          updatedAt: 1,
        },
      ],
      inUse: true,
      scripts: {
        updatedAt: 1,
        setup: {
          default: "old setup",
          macos: null,
          windows: null,
          linux: null,
        },
        teardown: {
          default: "old teardown",
          macos: null,
          windows: null,
          linux: null,
        },
      },
    };
    const fixture = createFixture([row("/wt/a", null, "(unresolved)")]);
    fixture.host.selection.set("/wt/a", oldSelection);
    markWorktreeChangedStreamOpen(HOST_ID);
    const { result } = renderHook(
      () =>
        useWorktreeEnrichmentForClient(fixture.client, ["/wt/a"], true, "none"),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("selection-answer"),
    );
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/a"]]);

    const laterListing = {
      ...row("/wt/a", 10, "listing-answer"),
      prState: null,
      owners: [
        {
          epicId: "new-epic",
          ownerKind: "chat" as const,
          ownerId: "new-chat",
          updatedAt: 2,
        },
      ],
      inUse: false,
      scripts: {
        updatedAt: 2,
        setup: {
          default: "new setup",
          macos: null,
          windows: null,
          linux: null,
        },
        teardown: {
          default: "new teardown",
          macos: null,
          windows: null,
          linux: null,
        },
      },
    };
    fixture.host.listing = [laterListing];
    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: false,
        worktreePaths: new Set(["/wt/a"]),
      });
    });

    await waitFor(() =>
      expect(result.current.worktrees[0]?.branch).toBe("listing-answer"),
    );
    expect(result.current.worktrees[0]).toMatchObject({
      resolvedAt: 10,
      branch: "listing-answer",
      owners: laterListing.owners,
      inUse: false,
      scripts: laterListing.scripts,
      prState: "open",
      prNumber: 43,
      prUrl: "https://example.test/pull/43",
      branchStatus: { ahead: 3, behind: 1, mergedIntoDefault: false },
    });
    await settle();
    expect(fixture.selectionCalls).toEqual([["/wt/a"], ["/wt/a"]]);
  });

  it("answers a root catch-up frame with one listing read and no per-row reads", async () => {
    const fixture = createFixture(RESOLVED);
    markWorktreeChangedStreamOpen(HOST_ID);
    const paths = ["/wt/a", "/wt/b"];

    const { result } = renderHook(
      () => useWorktreeEnrichmentForClient(fixture.client, paths, true, "none"),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => expect(result.current.worktrees).toHaveLength(2));

    act(() => {
      invalidateWorktreeChangedCaches(fixture.queryClient, HOST_ID, {
        root: true,
        worktreePaths: new Set(),
      });
    });
    await waitFor(() => expect(fixture.pagedCalls()).toBe(2));
    await settle();
    expect(fixture.selectionCalls).toEqual([]);
  });
});
