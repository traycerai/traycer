import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  WorktreeHostEntryV14,
  WorktreeListAllForHostResponseV14,
} from "@traycer/protocol/host/worktree-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  useCachedWorktreeEnrichment,
  useWorktreeActivityEnrichment,
} from "@/components/settings/panels/worktrees-enrichment";
import {
  persistWorktreeActivitySnapshot,
  readWorktreeActivitySnapshot,
} from "@/components/settings/panels/worktrees-enrichment-persistence";
import { worktreeActivityCacheKey } from "@/lib/persist";

// The enrichment hook reads/writes the warm-open snapshot in localStorage on
// every mount now - a snapshot leaked by one test would seed the next test's
// cache fold and skew its exact-count assertions.
afterEach(() => {
  window.localStorage.clear();
});

const HOST_ID = mockLocalHostEntry.hostId;
// Slightly over the hook's internal 80ms report debounce.
const WORKTREE_DEBOUNCE_SETTLE_MS = 120;
// Under fake timers the batcher's coalescing window arms only once the query
// actually mounts - i.e. during the act() flush AFTER an advance - so a fetch
// needs one more act-sized advance to hit the wire. Comfortably above the
// batcher's 25ms window.
const WORKTREE_BATCH_FLUSH_MS = 50;
// Passed as `worktreePaths` where a test exercises only the viewport
// machinery - an empty denominator keeps the background sweep inert.
const NO_SWEEP_PATHS: readonly string[] = [];

function enrichedEntry(
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
    // A real, host-validated merged status - i.e. fully enriched, not base-only.
    branchStatus: { ahead: 0, behind: 0, mergedIntoDefault: true },
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

const METHOD_SCOPE = hostQueryKeys.methodScope(
  HOST_ID,
  "worktree.listAllForHost",
);

function perPathKey(path: string): readonly unknown[] {
  return [
    ...METHOD_SCOPE,
    {
      includeActivity: true,
      activityPaths: [path],
      cursor: null,
      limit: null,
      // The directive is pinned to `false` in the cache identity and never
      // varies - a forced refetch lands in this same entry.
      forceRefresh: false,
    },
  ];
}

function baseKey(): readonly unknown[] {
  return [
    ...METHOD_SCOPE,
    {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: 32,
      forceRefresh: false,
    },
  ];
}

function seedEnriched(qc: QueryClient, entry: WorktreeHostEntryV14): void {
  qc.setQueryData<WorktreeListAllForHostResponseV14>(
    perPathKey(entry.worktreePath),
    {
      worktrees: [entry],
      nextCursor: null,
    },
  );
}

describe("useCachedWorktreeEnrichment (cache-backed overlay)", () => {
  afterEach(() => {
    cleanup();
  });

  it("folds per-path enrichment queries by path and EXCLUDES the base list", () => {
    const qc = new QueryClient();
    const a = enrichedEntry("/wt/a", "feat-a");
    seedEnriched(qc, a);
    // The base list (includeActivity: false) carries a DIFFERENT path's base-only
    // data. It must NOT enter the overlay - else that row would classify from
    // base-only fields instead of staying pending.
    qc.setQueryData<WorktreeListAllForHostResponseV14>(baseKey(), {
      worktrees: [enrichedEntry("/wt/b", "feat-b")],
      nextCursor: null,
    });

    const { result } = renderHook(() =>
      useCachedWorktreeEnrichment(qc, HOST_ID),
    );

    expect(result.current.get("/wt/a")).toBe(a);
    expect(result.current.has("/wt/b")).toBe(false);
  });

  it("hydrates a warm cache on the FIRST render (no empty→populated flash)", () => {
    const qc = new QueryClient();
    seedEnriched(qc, enrichedEntry("/wt/a", "feat-a"));
    seedEnriched(qc, enrichedEntry("/wt/b", "feat-b"));

    // No act()/waitFor: the very first snapshot already reflects the warm cache.
    const { result } = renderHook(() =>
      useCachedWorktreeEnrichment(qc, HOST_ID),
    );

    expect(result.current.has("/wt/a")).toBe(true);
    expect(result.current.has("/wt/b")).toBe(true);
  });

  it("grows monotonically as new per-path results land, never dropping prior paths", () => {
    const qc = new QueryClient();
    seedEnriched(qc, enrichedEntry("/wt/a", "feat-a"));
    const { result } = renderHook(() =>
      useCachedWorktreeEnrichment(qc, HOST_ID),
    );
    expect(result.current.has("/wt/a")).toBe(true);

    act(() => {
      seedEnriched(qc, enrichedEntry("/wt/c", "feat-c"));
    });

    expect(result.current.has("/wt/a")).toBe(true); // kept
    expect(result.current.has("/wt/c")).toBe(true); // added
  });

  it("returns a referentially STABLE snapshot until a relevant cache event", () => {
    const qc = new QueryClient();
    seedEnriched(qc, enrichedEntry("/wt/a", "feat-a"));
    const { result, rerender } = renderHook(() =>
      useCachedWorktreeEnrichment(qc, HOST_ID),
    );
    const first = result.current;

    // A re-render with no cache change hands back the SAME reference (a fresh
    // object every render would loop `useSyncExternalStore`).
    rerender();
    expect(result.current).toBe(first);

    // An UNRELATED cache event (outside the worktree method scope) must not churn
    // the overlay - the subscribe filter ignores it.
    act(() => {
      qc.setQueryData(hostQueryKeys.methodScope(HOST_ID, "epic.listTasks"), {
        x: 1,
      });
    });
    expect(result.current).toBe(first);
  });
});

describe("useWorktreeActivityEnrichment (window-independent overlay)", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function wrapperFor(qc: QueryClient) {
    return (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={qc}>{props.children}</QueryClientProvider>
    );
  }

  it("keeps a path enriched after it leaves the reported window (anti-oscillation)", () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    // Two paths already enriched in the cache (as if fetched moments ago).
    seedEnriched(qc, enrichedEntry("/wt/a", "feat-a"));
    seedEnriched(qc, enrichedEntry("/wt/b", "feat-b"));

    // client=null / reachable=false: no live fetching, so the ONLY source of the
    // overlay is the cache - proving it is independent of the reported window.
    const { result } = renderHook(
      () => useWorktreeActivityEnrichment(null, false, HOST_ID, NO_SWEEP_PATHS),
      { wrapper: wrapperFor(qc) },
    );
    expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
    expect(result.current.enrichedByPath.has("/wt/b")).toBe(true);

    // The window slides so only /wt/a is on screen; /wt/b leaves it. In the old
    // derived-from-window design this dropped /wt/b from the overlay, reverting it
    // to pending and re-entering under a filter (the 66↔70 flip). Now it persists.
    act(() => {
      result.current.reportVisiblePaths(["/wt/a"]);
      vi.advanceTimersByTime(WORKTREE_DEBOUNCE_SETTLE_MS);
    });

    expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
    expect(result.current.enrichedByPath.has("/wt/b")).toBe(true); // ← the fix
  });
});

describe("useWorktreeActivityEnrichment (live fetch → cache → overlay)", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function createFixture(
    entriesByPath: ReadonlyMap<string, WorktreeHostEntryV14>,
    onPathRequest: ((path: string) => void) | null,
    // Awaited per requested path before the response resolves - lets a test
    // hold probes in flight to observe dedupe. `null` = respond immediately
    // (no extra microtask boundary for the sync-handler tests).
    requestGate: ((path: string) => Promise<void>) | null,
    queryClient: QueryClient,
  ) {
    // One entry per WIRE call, carrying the batched `activityPaths` it asked
    // for - the chunking assertions read this (per-path counts stay on
    // `onPathRequest`).
    const wireRequests: Array<readonly string[]> = [];
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "worktree.listAllForHost": async (params) => {
            // Batched enrichment: the panel coalesces per-path queries into
            // chunked `activityPaths` calls; return the enriched entry for
            // each requested path.
            const paths =
              "activityPaths" in params && params.activityPaths !== null
                ? params.activityPaths
                : [];
            wireRequests.push([...paths]);
            const worktrees: WorktreeHostEntryV14[] = [];
            for (const path of paths) {
              // Snapshot the entry BEFORE the callbacks, so a callback that
              // mutates `entriesByPath` affects the NEXT request's response
              // (the warming-host shape the cold-retry tests model).
              const entry = entriesByPath.get(path);
              if (onPathRequest !== null) onPathRequest(path);
              if (requestGate !== null) await requestGate(path);
              if (entry !== undefined) worktrees.push(entry);
            }
            return { worktrees, nextCursor: null };
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
    return { client, Wrapper, queryClient, wireRequests };
  }

  it("enriches a reported window, then keeps it enriched after the window shrinks", async () => {
    const entriesByPath = new Map<string, WorktreeHostEntryV14>([
      ["/wt/a", enrichedEntry("/wt/a", "feat-a")],
      ["/wt/b", enrichedEntry("/wt/b", "feat-b")],
    ]);
    const fixture = createFixture(entriesByPath, null, null, new QueryClient());
    const { result } = renderHook(
      () =>
        useWorktreeActivityEnrichment(
          fixture.client,
          true,
          HOST_ID,
          NO_SWEEP_PATHS,
        ),
      { wrapper: fixture.Wrapper },
    );

    // Report both paths on screen → they fetch and land in the overlay.
    act(() => {
      result.current.reportVisiblePaths(["/wt/a", "/wt/b"]);
    });
    await waitFor(() => {
      expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
      expect(result.current.enrichedByPath.has("/wt/b")).toBe(true);
    });

    // /wt/b scrolls off; only /wt/a is reported. Its query goes inactive but stays
    // cached, so the overlay must NOT drop it (no revert-to-pending oscillation).
    act(() => {
      result.current.reportVisiblePaths(["/wt/a"]);
    });
    await new Promise((resolve) =>
      setTimeout(resolve, WORKTREE_DEBOUNCE_SETTLE_MS),
    );
    expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
    expect(result.current.enrichedByPath.has("/wt/b")).toBe(true);
  });

  it("still enriches when the first report fires during StrictMode's mount effect cycle (regression: a cleared debounce must re-arm)", async () => {
    // Guards the "second open never enriches" bug. With a WARM base list the
    // panel body and list mount in the same commit, so the list's first
    // visible-paths report fires INSIDE StrictMode's setup→cleanup→setup mount
    // cycle. The hook's unmount cleanup cleared the debounce timer but left the
    // timer id in the ref, permanently wedging the old "skip if a timer is
    // pending" debounce: requestedPaths never committed, no enrichment query
    // was ever created, and every un-cached row spun at "Checking…" forever.
    // The debounce now clears-and-re-arms on every report, so the wedge state
    // is unreachable by construction.
    //
    // HARNESS LIMITATION: this vitest/jsdom setup does not run StrictMode's
    // double-invoked effect cycle (verified empirically - a mount effect under
    // <StrictMode> fires exactly once here), so this test could NOT reproduce
    // the wedge red against the old code. It stays as a canary: it exercises
    // the exact production shape (report from a mount effect under
    // StrictMode), and becomes a real regression net the moment the test
    // runtime gains dev-mode double-invocation.
    const entriesByPath = new Map<string, WorktreeHostEntryV14>([
      ["/wt/a", enrichedEntry("/wt/a", "feat-a")],
    ]);
    const fixture = createFixture(entriesByPath, null, null, new QueryClient());
    // Mimic the list: report on-screen paths from a MOUNT EFFECT, exactly where
    // StrictMode's double-invoked effect cycle bites.
    function useEnrichmentReportingOnMount() {
      const enrichment = useWorktreeActivityEnrichment(
        fixture.client,
        true,
        HOST_ID,
        NO_SWEEP_PATHS,
      );
      const { reportVisiblePaths } = enrichment;
      useEffect(() => {
        reportVisiblePaths(["/wt/a"]);
      }, [reportVisiblePaths]);
      return enrichment;
    }
    const { result } = renderHook(() => useEnrichmentReportingOnMount(), {
      wrapper: (props: { readonly children: ReactNode }): ReactNode => (
        <StrictMode>
          <fixture.Wrapper>{props.children}</fixture.Wrapper>
        </StrictMode>
      ),
    });

    await waitFor(() => {
      expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
    });
  });

  it("refetches cold null PR state and stops after it resolves", async () => {
    vi.useFakeTimers();
    const coldEntry = enrichedEntry("/wt/a", "feat-a");
    const resolvedEntry: WorktreeHostEntryV14 = {
      ...coldEntry,
      prState: "open",
      prNumber: 42,
      prUrl: "https://github.com/acme/app/pull/42",
    };
    const entriesByPath = new Map<string, WorktreeHostEntryV14>([
      ["/wt/a", coldEntry],
    ]);
    const requests: string[] = [];
    const fixture = createFixture(
      entriesByPath,
      (path) => {
        requests.push(path);
        if (requests.length === 1) entriesByPath.set(path, resolvedEntry);
      },
      null,
      new QueryClient(),
    );
    const { result } = renderHook(
      () =>
        useWorktreeActivityEnrichment(
          fixture.client,
          true,
          HOST_ID,
          NO_SWEEP_PATHS,
        ),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      result.current.reportVisiblePaths(["/wt/a"]);
      await vi.advanceTimersByTimeAsync(WORKTREE_DEBOUNCE_SETTLE_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
    });
    expect(requests).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(requests).toHaveLength(2);
    expect(result.current.enrichedByPath.get("/wt/a")?.prState).toBe("open");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(requests).toHaveLength(2);
  });

  it("refetches when a SUBMODULE leg is cold even though the superproject is proven", async () => {
    vi.useFakeTimers();
    // The noble-weasel shape: superproject fully proven merged, but an owned
    // submodule's PR fact is still `null` (warming). One unproven submodule
    // holds the row in Review, so the retry must fire off the submodule leg.
    const coldSubmodule = {
      repoIdentifier: { owner: "acme", repo: "lib" },
      branch: "traycer/sub",
      prState: null,
      prNumber: null,
      prUrl: null,
      mergedHeadShaMatches: false,
      mergedIntoDefault: false,
      atPinnedCommit: false,
      unmergedCommitCount: null,
      unmergedCommitSubjects: null,
    };
    const coldEntry: WorktreeHostEntryV14 = {
      ...enrichedEntry("/wt/a", "feat-a"),
      prState: "merged",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      mergedHeadShaMatches: true,
      submodules: [coldSubmodule],
    };
    const resolvedEntry: WorktreeHostEntryV14 = {
      ...coldEntry,
      submodules: [
        {
          ...coldSubmodule,
          prState: "merged",
          prNumber: 9,
          prUrl: "https://github.com/acme/lib/pull/9",
          mergedHeadShaMatches: true,
        },
      ],
    };
    const entriesByPath = new Map<string, WorktreeHostEntryV14>([
      ["/wt/a", coldEntry],
    ]);
    const requests: string[] = [];
    const fixture = createFixture(
      entriesByPath,
      (path) => {
        requests.push(path);
        if (requests.length === 1) entriesByPath.set(path, resolvedEntry);
      },
      null,
      new QueryClient(),
    );
    const { result } = renderHook(
      () =>
        useWorktreeActivityEnrichment(
          fixture.client,
          true,
          HOST_ID,
          NO_SWEEP_PATHS,
        ),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      result.current.reportVisiblePaths(["/wt/a"]);
      await vi.advanceTimersByTimeAsync(WORKTREE_DEBOUNCE_SETTLE_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
    });
    expect(requests).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    // The retry fired and the warmed submodule fact landed; no further retries
    // once every leg is probed.
    expect(requests).toHaveLength(2);
    expect(
      result.current.enrichedByPath.get("/wt/a")?.submodules[0].prState,
    ).toBe("merged");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(requests).toHaveLength(2);
  });

  it("stops cold PR refetching after the bounded retry budget", async () => {
    vi.useFakeTimers();
    const entriesByPath = new Map<string, WorktreeHostEntryV14>([
      ["/wt/a", enrichedEntry("/wt/a", "feat-a")],
    ]);
    const requests: string[] = [];
    const fixture = createFixture(
      entriesByPath,
      (path) => {
        requests.push(path);
      },
      null,
      new QueryClient(),
    );
    const { result } = renderHook(
      () =>
        useWorktreeActivityEnrichment(
          fixture.client,
          true,
          HOST_ID,
          NO_SWEEP_PATHS,
        ),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      result.current.reportVisiblePaths(["/wt/a"]);
      await vi.advanceTimersByTimeAsync(WORKTREE_DEBOUNCE_SETTLE_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
    });
    expect(requests).toHaveLength(1);

    // Exponential backoff (750ms, 1.5s, 3s, 6s, 12s, then 20s flat), budgeted
    // at 10 retries - patient enough for a loaded host whose background gh
    // probes take tens of seconds to warm, but still bounded.
    const retrySteps = [
      { advanceMs: 800, expectedCount: 2 },
      { advanceMs: 1_600, expectedCount: 3 },
      { advanceMs: 3_100, expectedCount: 4 },
      { advanceMs: 6_100, expectedCount: 5 },
      { advanceMs: 12_100, expectedCount: 6 },
    ];
    for (const step of retrySteps) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(step.advanceMs);
      });
      expect(requests).toHaveLength(step.expectedCount);
    }

    // Retries 6-10 wait the 20s cap each; past the budget, silence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(110_000);
    });
    expect(requests).toHaveLength(11);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(requests).toHaveLength(11);
  });

  describe("background sweep (no scrolling required)", () => {
    function warmEntry(path: string, branch: string): WorktreeHostEntryV14 {
      // `prState: "none"` = probed, no PR - a WARM row the sweep must fetch
      // exactly once and then leave alone (the shared fixture's `null` means
      // cold/unprobed and would re-arm the retry budget).
      return { ...enrichedEntry(path, branch), prState: "none" };
    }

    it("sweeps every un-reported path in bounded chunks until the whole list enriches", async () => {
      const paths = Array.from({ length: 20 }, (_, i) => `/wt/sweep-${i}`);
      const entriesByPath = new Map<string, WorktreeHostEntryV14>(
        paths.map((path, i) => [path, warmEntry(path, `feat-${i}`)]),
      );
      const requests: string[] = [];
      const fixture = createFixture(
        entriesByPath,
        (path) => {
          requests.push(path);
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, paths),
        { wrapper: fixture.Wrapper },
      );

      // NO reportVisiblePaths at all - the sweep alone must converge the list.
      await waitFor(() => {
        expect(result.current.enrichedByPath.size).toBe(20);
      });
      // Every path probed exactly once…
      expect([...requests].sort()).toEqual([...paths].sort());
      // …and the wire is genuinely batched: each sweep chunk rides ONE
      // `activityPaths` call bounded at the chunk size - 20 paths is exactly
      // ceil(20/8) = 3 calls, never a per-path fan-out or a whole-list call.
      expect(fixture.wireRequests).toHaveLength(3);
      for (const call of fixture.wireRequests) {
        expect(call.length).toBeLessThanOrEqual(8);
      }
      expect(fixture.wireRequests.some((call) => call.length > 1)).toBe(true);
    });

    it("probes a path exactly once when the sweep and the viewport race for it", async () => {
      const entriesByPath = new Map<string, WorktreeHostEntryV14>([
        ["/wt/a", warmEntry("/wt/a", "feat-a")],
      ]);
      const requests: string[] = [];
      const fixture = createFixture(
        entriesByPath,
        (path) => {
          requests.push(path);
        },
        // Hold the probe past the 80ms report debounce, so the mount-time sweep
        // chunk and the viewport observer overlap on the same in-flight query.
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
        },
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );
      act(() => {
        result.current.reportVisiblePaths(["/wt/a"]);
      });

      await waitFor(() => {
        expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
      });
      // Settle window: a spurious second fetch would fire right after the first
      // resolves, so give it the chance to prove absent.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(requests).toHaveLength(1);
    });

    it("retries a swept path that lands cold, then stops once it resolves", async () => {
      vi.useFakeTimers();
      const coldEntry = enrichedEntry("/wt/a", "feat-a"); // prState null = cold
      const resolvedEntry = warmEntry("/wt/a", "feat-a");
      const entriesByPath = new Map<string, WorktreeHostEntryV14>([
        ["/wt/a", coldEntry],
      ]);
      const requests: string[] = [];
      const fixture = createFixture(
        entriesByPath,
        (path) => {
          requests.push(path);
          if (requests.length === 1) entriesByPath.set(path, resolvedEntry);
        },
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );

      // The mount-time sweep chunk fires without any visible-paths report
      // (one advance to let the batcher's coalescing window flush).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
      });
      expect(requests).toHaveLength(1);

      // Cold → the sweep's exponential backoff re-probes it (first retry
      // after 750ms; the re-probe's batch window flushes on its own advance).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
      });
      expect(requests).toHaveLength(2);
      expect(result.current.enrichedByPath.get("/wt/a")?.prState).toBe("none");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(requests).toHaveLength(2);
    });

    it("stops sweeping a permanently cold path after the bounded probe budget", async () => {
      vi.useFakeTimers();
      const entriesByPath = new Map<string, WorktreeHostEntryV14>([
        ["/wt/a", enrichedEntry("/wt/a", "feat-a")],
      ]);
      const requests: string[] = [];
      const fixture = createFixture(
        entriesByPath,
        (path) => {
          requests.push(path);
        },
        null,
        createAppQueryClient(),
      );
      renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
      });
      expect(requests).toHaveLength(1);

      // The sweep budgets PROBES per path (10): initial at t=0, then
      // exponential-backoff retries (750ms, 1.5s, 3s, … capped at 20s); after
      // the budget the path is left to the viewport machinery (scrolling to
      // it still retries on its own budget).
      const retrySteps = [
        { advanceMs: 800, expectedCount: 2 },
        { advanceMs: 1_600, expectedCount: 3 },
        { advanceMs: 3_100, expectedCount: 4 },
      ];
      for (const step of retrySteps) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(step.advanceMs);
        });
        // Each re-probe's batch window flushes on its own advance.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
        });
        expect(requests).toHaveLength(step.expectedCount);
      }

      // The rest of the budget drains across the capped waits. Walk it in
      // act-sized windows: each probe's settle schedules the next wake via a
      // React state bump, and effects only flush at act() boundaries - one
      // long advance would fire at most one more probe.
      for (let window = 0; window < 12; window += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
      });
      expect(requests).toHaveLength(10);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(requests).toHaveLength(10);
    });

    it("re-probes swept entries after a method-scope invalidation (refresh), still in bounded chunks", async () => {
      const paths = Array.from({ length: 12 }, (_, i) => `/wt/refresh-${i}`);
      const entriesByPath = new Map<string, WorktreeHostEntryV14>(
        paths.map((path, i) => [path, warmEntry(path, `feat-${i}`)]),
      );
      const requests: string[] = [];
      const fixture = createFixture(
        entriesByPath,
        (path) => {
          requests.push(path);
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, paths),
        { wrapper: fixture.Wrapper },
      );
      await waitFor(() => {
        expect(result.current.enrichedByPath.size).toBe(12);
      });
      expect(requests).toHaveLength(12);
      const wireCallsBeforeRefresh = fixture.wireRequests.length;

      // A refresh invalidates the method scope with `refetchType: "active"`
      // (mirroring `WorktreesBody.onRefresh`). The swept entries have no
      // observers, so nothing refetches directly - only the sweep can pick
      // them back up, woken by the invalidation cache event. The re-sweep must
      // be the same bounded chunk walk, never a whole-list fan-out: every path
      // re-probed exactly once, riding chunk-sized batched wire calls.
      await act(async () => {
        await fixture.queryClient.invalidateQueries({
          queryKey: METHOD_SCOPE,
          refetchType: "active",
        });
      });
      await waitFor(() => {
        expect(requests).toHaveLength(24);
      });
      expect([...requests.slice(12)].sort()).toEqual([...paths].sort());
      const resweepCalls = fixture.wireRequests.slice(wireCallsBeforeRefresh);
      expect(resweepCalls).toHaveLength(2); // ceil(12/8)
      for (const call of resweepCalls) {
        expect(call.length).toBeLessThanOrEqual(8);
      }
      expect(resweepCalls.some((call) => call.length > 1)).toBe(true);
    });

    it("keeps a permanently rejecting refresh bounded (regression: isInvalidated persists across failed refetches)", async () => {
      vi.useFakeTimers();
      const entriesByPath = new Map<string, WorktreeHostEntryV14>([
        ["/wt/a", warmEntry("/wt/a", "feat-a")],
      ]);
      const requests: string[] = [];
      const fixture = createFixture(
        entriesByPath,
        (path) => {
          requests.push(path);
          // Every request after the initial sweep fails - the host went away.
          if (requests.length > 1) throw new Error("host unreachable");
        },
        null,
        createAppQueryClient(),
      );
      renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKTREE_BATCH_FLUSH_MS);
      });
      expect(requests).toHaveLength(1);

      // Refresh. A rejected refetch does NOT clear `isInvalidated` - only a
      // successful one does - so the sweep must consume its ONE granted
      // budget and then stop, instead of re-granting on every pass and
      // probing forever. The budget allows 10 probes, each at most 2 handler
      // calls (the app QueryClient's single query-level retry): ceiling
      // 1 + 10×2 = 21. Effect scheduling under fake timers flushes at act()
      // boundaries, so walk several generous windows (covering the full
      // ~103s backoff schedule) and assert the total STABILIZES under that
      // ceiling - the regression (re-granting the budget on every pass)
      // keeps probing in every window and blows far past it.
      await act(async () => {
        await fixture.queryClient.invalidateQueries({
          queryKey: METHOD_SCOPE,
          refetchType: "active",
        });
      });
      for (let window = 0; window < 16; window += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000);
        });
      }
      const settled = requests.length;
      expect(settled).toBeGreaterThan(1); // the grant did allow re-probing
      expect(settled).toBeLessThanOrEqual(21);

      // No further probes, ever - the budget stays consumed while the
      // invalidation persists.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(requests).toHaveLength(settled);
    });
  });

  describe("sentinel guard (cold-host clobber regression)", () => {
    // A cold host answers reads it cannot derive with the `unresolvedRow`
    // SENTINEL - `resolvedAt: null`, unknown branch, `gitRemovable: false` -
    // which the panel renders as "detached HEAD" / "Waiting for host
    // verification…". Caching those over good rows (and then persisting them)
    // turned one cold read into a fleet of permanently-unknown rows.
    function sentinelEntry(worktreePath: string): WorktreeHostEntryV14 {
      return {
        ...enrichedEntry(worktreePath, "feat-a"),
        branch: null,
        gitRemovable: false,
        branchStatus: null,
        resolvedAt: null,
      };
    }

    it("keeps a resolved cached row when a later read answers with the sentinel", async () => {
      const resolved: WorktreeHostEntryV14 = {
        ...enrichedEntry("/wt/a", "feat-a"),
        prState: "none",
      };
      const entriesByPath = new Map<string, WorktreeHostEntryV14>([
        ["/wt/a", resolved],
      ]);
      // Count host reads so we can prove the sentinel refetch actually landed.
      // The guard's whole job is to leave the cached data UNCHANGED, so a
      // `waitFor` on the data cannot tell "guard preserved the row" apart from
      // "the refetch never happened" - only the request count can.
      const requests: string[] = [];
      const fixture = createFixture(
        entriesByPath,
        (path) => requests.push(path),
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );
      await waitFor(() => {
        expect(result.current.enrichedByPath.get("/wt/a")?.branch).toBe(
          "feat-a",
        );
      });
      const requestsBeforeSentinel = requests.length;

      // The host goes cold (restart) and now answers the sentinel. Invalidation
      // re-arms the sweep, which re-probes the row through the batcher.
      entriesByPath.set("/wt/a", sentinelEntry("/wt/a"));
      await act(async () => {
        await fixture.queryClient.invalidateQueries({
          queryKey: METHOD_SCOPE,
          refetchType: "active",
        });
      });
      // The sentinel response must actually land before the assertion, or the
      // test would pass trivially on stale cache without exercising the guard.
      await waitFor(() => {
        expect(requests.length).toBeGreaterThan(requestsBeforeSentinel);
      });

      // Guard kept the resolved row despite the sentinel refetch landing.
      expect(result.current.enrichedByPath.get("/wt/a")?.branch).toBe("feat-a");
      expect(
        result.current.enrichedByPath.get("/wt/a")?.resolvedAt,
      ).not.toBeNull();
    });

    it("still accepts a resolved row that replaces another resolved row", async () => {
      const first: WorktreeHostEntryV14 = {
        ...enrichedEntry("/wt/a", "feat-a"),
        prState: "none",
      };
      const renamed: WorktreeHostEntryV14 = {
        ...enrichedEntry("/wt/a", "feat-renamed"),
        prState: "none",
      };
      const entriesByPath = new Map<string, WorktreeHostEntryV14>([
        ["/wt/a", first],
      ]);
      const fixture = createFixture(
        entriesByPath,
        null,
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );
      await waitFor(() => {
        expect(result.current.enrichedByPath.get("/wt/a")?.branch).toBe(
          "feat-a",
        );
      });

      // Guard must not freeze the cache: resolved data still wins.
      entriesByPath.set("/wt/a", renamed);
      await act(async () => {
        await fixture.queryClient.invalidateQueries({
          queryKey: METHOD_SCOPE,
          refetchType: "active",
        });
      });
      await waitFor(() => {
        expect(result.current.enrichedByPath.get("/wt/a")?.branch).toBe(
          "feat-renamed",
        );
      });
    });
  });

  describe("overlay identity stability (render-churn regression)", () => {
    // Every distinct overlay identity fans out through the panel: merged rows,
    // task rollups, filters, and finally a re-render of EVERY worktree row
    // (100-450ms long tasks on a 50-row fleet). So identity churn without a
    // data change IS the bug these tests pin down.
    function warmEntry(path: string, branch: string): WorktreeHostEntryV14 {
      return { ...enrichedEntry(path, branch), prState: "none" };
    }

    it("keeps the overlay Map identity when a re-probe lands identical data", async () => {
      const requests: string[] = [];
      const fixture = createFixture(
        new Map([["/wt/a", warmEntry("/wt/a", "feat-a")]]),
        (path) => {
          requests.push(path);
        },
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );
      await waitFor(() => {
        expect(result.current.enrichedByPath.size).toBe(1);
      });
      const before = result.current.enrichedByPath;

      // Refresh → the swept entry re-probes and the host answers with the
      // exact same data. Structural sharing keeps the entry identity, so the
      // fold must keep the MAP identity too.
      await act(async () => {
        await fixture.queryClient.invalidateQueries({
          queryKey: METHOD_SCOPE,
          refetchType: "active",
        });
      });
      await waitFor(() => {
        expect(requests).toHaveLength(2);
        expect(fixture.queryClient.isFetching()).toBe(0);
      });
      expect(result.current.enrichedByPath).toBe(before);
    });

    it("never churns the overlay identity on an invalidation mark alone", async () => {
      const fixture = createFixture(
        new Map([["/wt/a", warmEntry("/wt/a", "feat-a")]]),
        null,
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );
      await waitFor(() => {
        expect(result.current.enrichedByPath.size).toBe(1);
      });
      const before = result.current.enrichedByPath;

      // A pure mark: no refetch (`refetchType: "none"`), no data change. The
      // fold's subscription must not dirty (an `invalidate` action can't
      // change folded data), so the overlay identity holds.
      await act(async () => {
        await fixture.queryClient.invalidateQueries({
          queryKey: METHOD_SCOPE,
          refetchType: "none",
        });
      });
      expect(result.current.enrichedByPath).toBe(before);
    });
  });

  describe("warm-open persistence (localStorage snapshot)", () => {
    function warmEntry(path: string, branch: string): WorktreeHostEntryV14 {
      return { ...enrichedEntry(path, branch), prState: "none" };
    }

    // Writes a last-run snapshot the way the production writer does, so the
    // restore path exercises a genuine round-trip (schema validation and all).
    function seedLastRunSnapshot(
      entries: readonly WorktreeHostEntryV14[],
      savedAt: number,
    ): void {
      persistWorktreeActivitySnapshot({
        hostId: HOST_ID,
        worktreePaths: entries.map((entry) => entry.worktreePath),
        enrichedByPath: new Map(
          entries.map((entry) => [entry.worktreePath, entry]),
        ),
        now: savedAt,
      });
    }

    it("seeds the last run's snapshot before any probe resolves, then revalidates it in the background", async () => {
      const restoredA = warmEntry("/wt/a", "feat-a");
      const restoredB = warmEntry("/wt/b", "feat-b");
      seedLastRunSnapshot([restoredA, restoredB], Date.now() - 60_000);
      // Since the last run, /wt/a's PR merged - the host now serves fresher
      // data than the snapshot. The restored tier must show instantly and the
      // live truth must replace it.
      const freshA: WorktreeHostEntryV14 = {
        ...restoredA,
        prState: "merged",
        prNumber: 5,
        prUrl: "https://github.com/acme/app/pull/5",
        mergedHeadShaMatches: true,
      };
      const requests: string[] = [];
      const fixture = createFixture(
        new Map([
          ["/wt/a", freshA],
          ["/wt/b", warmEntry("/wt/b", "feat-b")],
        ]),
        (path) => {
          requests.push(path);
        },
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
            "/wt/b",
          ]),
        { wrapper: fixture.Wrapper },
      );

      // Warm open: restored tiers are in the overlay IMMEDIATELY - no probe
      // has resolved yet (the handlers park on the microtask queue).
      expect(result.current.enrichedByPath.get("/wt/a")?.prState).toBe("none");
      expect(result.current.enrichedByPath.get("/wt/b")?.prState).toBe("none");
      // Seeded entries are marked for revalidation, never treated as settled.
      expect(
        fixture.queryClient.getQueryState(perPathKey("/wt/a"))?.isInvalidated,
      ).toBe(true);

      // The sweep revalidates every restored row; live truth wins.
      await waitFor(() => {
        expect(result.current.enrichedByPath.get("/wt/a")?.prState).toBe(
          "merged",
        );
      });
      expect([...requests].sort()).toEqual(["/wt/a", "/wt/b"]);
    });

    it("reports restored paths as SEEDED until a live probe replaces them (delete-gate input)", async () => {
      seedLastRunSnapshot([warmEntry("/wt/a", "feat-a")], Date.now() - 60_000);
      const liveA: WorktreeHostEntryV14 = {
        ...warmEntry("/wt/a", "feat-a"),
        prState: "merged",
        prNumber: 5,
        prUrl: "https://github.com/acme/app/pull/5",
        mergedHeadShaMatches: true,
      };
      const fixture = createFixture(
        new Map([["/wt/a", liveA]]),
        null,
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );

      // Restored data displays instantly, but is flagged as the seed - the
      // panel's delete surfaces treat these paths as not-yet-verified.
      expect(result.current.enrichedByPath.has("/wt/a")).toBe(true);
      expect(result.current.seededPaths.has("/wt/a")).toBe(true);

      // The live revalidation replaces the seed → the flag drops with it.
      await waitFor(() => {
        expect(result.current.enrichedByPath.get("/wt/a")?.prState).toBe(
          "merged",
        );
        expect(result.current.seededPaths.has("/wt/a")).toBe(false);
      });
    });

    it("drops the SEEDED flag even when revalidation lands identical data", async () => {
      // The common warm-open case: nothing changed since last run, so the
      // live probe answers with byte-identical data. Structural sharing then
      // keeps the entry identity and the overlay identity holds - but the
      // query's `dataUpdatedAt` is now this session's, so the path must still
      // flip seeded → live (the delete gate must not stay locked).
      seedLastRunSnapshot([warmEntry("/wt/a", "feat-a")], Date.now() - 60_000);
      const requests: string[] = [];
      const fixture = createFixture(
        new Map([["/wt/a", warmEntry("/wt/a", "feat-a")]]),
        (path) => {
          requests.push(path);
        },
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );
      expect(result.current.seededPaths.has("/wt/a")).toBe(true);

      await waitFor(() => {
        expect(requests).toHaveLength(1);
        expect(fixture.queryClient.isFetching()).toBe(0);
        expect(result.current.seededPaths.has("/wt/a")).toBe(false);
      });
    });

    it("never overwrites live cache data with the snapshot", () => {
      const liveA: WorktreeHostEntryV14 = {
        ...warmEntry("/wt/a", "feat-a"),
        prState: "open",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
      };
      seedLastRunSnapshot([warmEntry("/wt/a", "feat-a")], Date.now());
      const qc = createAppQueryClient();
      qc.setQueryData<WorktreeListAllForHostResponseV14>(perPathKey("/wt/a"), {
        worktrees: [liveA],
        nextCursor: null,
      });
      const fixture = createFixture(
        new Map([["/wt/a", liveA]]),
        null,
        null,
        qc,
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
          ]),
        { wrapper: fixture.Wrapper },
      );

      expect(result.current.enrichedByPath.get("/wt/a")?.prState).toBe("open");
      // The cached response itself is untouched: a seed would have replaced
      // it with the snapshot's `prState: "none"` entry. (`isInvalidated` is
      // no probe here - `HostClient.bind` invalidates the whole host scope on
      // its own.)
      const cached =
        fixture.queryClient.getQueryData<WorktreeListAllForHostResponseV14>(
          perPathKey("/wt/a"),
        );
      expect(cached?.worktrees[0]?.prState).toBe("open");
    });

    it("discards an expired snapshot - cold open, storage cleaned up", () => {
      seedLastRunSnapshot(
        [warmEntry("/wt/a", "feat-a")],
        Date.now() - 8 * 24 * 60 * 60_000,
      );
      const fixture = createFixture(
        new Map(),
        null,
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(
            fixture.client,
            true,
            HOST_ID,
            NO_SWEEP_PATHS,
          ),
        { wrapper: fixture.Wrapper },
      );

      expect(result.current.enrichedByPath.size).toBe(0);
      expect(
        window.localStorage.getItem(worktreeActivityCacheKey(HOST_ID)),
      ).toBeNull();
    });

    it("survives a corrupt snapshot - cold open, storage cleaned up", () => {
      window.localStorage.setItem(
        worktreeActivityCacheKey(HOST_ID),
        "{not json",
      );
      const fixture = createFixture(
        new Map(),
        null,
        null,
        createAppQueryClient(),
      );
      const { result } = renderHook(
        () =>
          useWorktreeActivityEnrichment(
            fixture.client,
            true,
            HOST_ID,
            NO_SWEEP_PATHS,
          ),
        { wrapper: fixture.Wrapper },
      );

      expect(result.current.enrichedByPath.size).toBe(0);
      expect(
        window.localStorage.getItem(worktreeActivityCacheKey(HOST_ID)),
      ).toBeNull();
    });

    it("writes a debounced snapshot of the WARM entries once the fold settles", async () => {
      vi.useFakeTimers();
      const entriesByPath = new Map<string, WorktreeHostEntryV14>([
        ["/wt/a", warmEntry("/wt/a", "feat-a")],
        // Permanently cold - must never enter the snapshot (restoring it
        // would just re-render "Checking…" and burn a probe).
        ["/wt/b", enrichedEntry("/wt/b", "feat-b")],
      ]);
      const fixture = createFixture(
        entriesByPath,
        null,
        null,
        createAppQueryClient(),
      );
      renderHook(
        () =>
          useWorktreeActivityEnrichment(fixture.client, true, HOST_ID, [
            "/wt/a",
            "/wt/b",
          ]),
        { wrapper: fixture.Wrapper },
      );

      // Sweep probes both; /wt/b's cold retries and the persist debounce all
      // land comfortably inside this window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      const snapshot = readWorktreeActivitySnapshot(HOST_ID, Date.now());
      expect(snapshot?.entries.map((entry) => entry.worktreePath)).toEqual([
        "/wt/a",
      ]);
    });

    it("keeps only listed, warm entries in listing order - and an empty fold never clobbers the snapshot", () => {
      const a = warmEntry("/wt/a", "feat-a");
      const b = warmEntry("/wt/b", "feat-b");
      persistWorktreeActivitySnapshot({
        hostId: HOST_ID,
        // /wt/gone enriched once but left the listing (deleted worktree):
        // dropped. Listing order (b before a) is preserved.
        worktreePaths: ["/wt/b", "/wt/a"],
        enrichedByPath: new Map([
          ["/wt/a", a],
          ["/wt/b", b],
          ["/wt/gone", warmEntry("/wt/gone", "feat-gone")],
          ["/wt/cold", enrichedEntry("/wt/cold", "feat-cold")],
        ]),
        now: Date.now(),
      });
      const written = readWorktreeActivitySnapshot(HOST_ID, Date.now());
      expect(written?.entries.map((entry) => entry.worktreePath)).toEqual([
        "/wt/b",
        "/wt/a",
      ]);

      // An early empty fold must not clobber the previous run's snapshot.
      persistWorktreeActivitySnapshot({
        hostId: HOST_ID,
        worktreePaths: ["/wt/b", "/wt/a"],
        enrichedByPath: new Map(),
        now: Date.now(),
      });
      const after = readWorktreeActivitySnapshot(HOST_ID, Date.now());
      expect(after?.entries.map((entry) => entry.worktreePath)).toEqual([
        "/wt/b",
        "/wt/a",
      ]);
    });
  });
});
